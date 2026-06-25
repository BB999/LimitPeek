'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  Tray,
  BrowserWindow,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
} = require('electron');
const store = require('./store');
const { UsageStore } = require('./usageStore');
const { SessionDetector } = require('./sessionDetect');

let tray = null;
let popup = null;
let trayRenderer = null; // Tray 画像を Canvas 合成する隠しウィンドウ
let trayRendererReady = false;
let usage = null;
let settings = null;
let lastSnap = null;

// --- セッション稼働アニメーション（パルス）--------------------------------
let sessionDetector = null;
let sessions = { claude: false, codex: false }; // 各 CLI が稼働中か
let pulseTimer = null;                            // アニメフレーム送出タイマー
let pulsePhase = 0;                               // 0..1 を周期的に進める位相
const PULSE_FPS = 12;                             // フレームレート（CPU 負荷を抑える）
const PULSE_PERIOD_MS = 1400;                     // 1 周期の長さ（ふわっと拡縮）

// パルスのアニメが必要か（設定 ON かつ いずれかのセッション稼働中）
function pulseActive() {
  if (!settings || !settings.pulseOnSession) return false;
  return sessions.claude || sessions.codex;
}

// 各ロゴの拡大率(scale)を位相から算出。稼働中のロゴだけ 1.0→1.18 を行き来する。
function pulseScales() {
  // sin 波で 0..1。ease がかかって自然に見える。
  const wave = (1 - Math.cos(pulsePhase * Math.PI * 2)) / 2; // 0..1
  const amp = 0.45; // 最大拡大率（+45%）。ロゴ基準サイズ(SIZE=14)を小さめにして
                    // トレイ高(H=22)に収まる範囲で拡縮の幅を大きく見せる。
  const s = 1 + wave * amp;
  return {
    claude: pulseActive() && sessions.claude ? s : 1,
    codex: pulseActive() && sessions.codex ? s : 1,
  };
}

function startPulseLoop() {
  if (pulseTimer) return;
  pulseTimer = setInterval(() => {
    if (!pulseActive()) { stopPulseLoop(); return; }
    pulsePhase = (pulsePhase + (1000 / PULSE_FPS) / PULSE_PERIOD_MS) % 1;
    if (lastSnap) requestTrayRender(lastSnap);
  }, Math.round(1000 / PULSE_FPS));
}

function stopPulseLoop() {
  if (pulseTimer) clearInterval(pulseTimer);
  pulseTimer = null;
  pulsePhase = 0;
  // パルス停止後、等倍の状態で 1 枚描き直して残像を消す。
  if (lastSnap) requestTrayRender(lastSnap);
}

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SVGS = {
  claude: fs.readFileSync(path.join(ASSETS, 'claude.svg'), 'utf8'),
  codex: fs.readFileSync(path.join(ASSETS, 'codex.svg'), 'utf8'),
};
const APP_ICON_PATH = path.join(ASSETS, 'icon.png');

// アプリアイコンを設定してから Dock を隠す（メニューバー常駐アプリ）
if (process.platform === 'darwin' && app.dock) {
  try { app.dock.setIcon(APP_ICON_PATH); } catch { /* noop */ }
  app.dock.hide();
}

// 単一インスタンス
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// --- Tray 表示アイテムの組み立て ------------------------------------------
// メニューバーには [Claudeロゴ]17% [Codexロゴ]22% を出す。
// 設定 trayWindow で出す窓を切り替え:
//   '5h'   → 5h 窓のみ（例: 17%）
//   '7d'   → 7d 窓のみ（例: 5%）
//   'both' → 両方併記（例: 17% / 5%）
function trayItems(snap) {
  const items = [];
  const mode = (settings && settings.trayWindow) || '5h';
  const pctOf = (win) => (win ? `${Math.round(win.usedPercent)}%` : '—');
  const pick = (svc) => {
    if (!svc.enabled) return null;
    if (svc.error && !svc.data) return '…';
    const d = svc.data;
    if (!d) return '…';
    if (mode === 'both') return `${pctOf(d.fiveHour)} / ${pctOf(d.sevenDay)}`;
    const win = mode === '7d' ? d.sevenDay : d.fiveHour;
    return win ? `${Math.round(win.usedPercent)}%` : '…';
  };
  const c = pick(snap.claude);
  const x = pick(snap.codex);
  if (c != null) items.push({ logo: 'claude', text: c });
  if (x != null) items.push({ logo: 'codex', text: x });
  return items;
}

// --- Tray 画像合成（隠しレンダラに依頼）-----------------------------------
function createTrayRenderer() {
  trayRenderer = new BrowserWindow({
    width: 240,
    height: 60,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });
  trayRenderer.loadFile(path.join(__dirname, '..', 'renderer', 'trayicon.html'));

  if (process.env.LIMITPEEK_DEBUG_IMG) {
    trayRenderer.webContents.on('console-message', (_e, level, message) => {
      console.log('[trayRenderer]', message);
    });
    trayRenderer.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('[trayRenderer] did-fail-load', code, desc);
    });
  }
}

function requestTrayRender(snap) {
  if (!trayRenderer || !trayRendererReady) return;
  const items = trayItems(snap);
  if (!items.length) {
    // 監視対象なし or 全滅: 文字だけのフォールバック
    if (tray) {
      tray.setImage(nativeImage.createEmpty());
      tray.setTitle(' Limit');
    }
    return;
  }
  const scale = screen.getPrimaryDisplay().scaleFactor || 2;
  // 稼働中ロゴの拡大率を載せる。レンダラ側はロゴ描画時にこれを使う。
  const pulse = pulseScales();
  trayRenderer.webContents.send('render-tray', { items, scale, svgs: SVGS, pulse });
}

// --- ポップアップウィンドウ ----------------------------------------------
const POPUP_WIDTH = 300;

function createPopup() {
  popup = new BrowserWindow({
    width: POPUP_WIDTH,
    height: 240,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    vibrancy: 'menu',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popup.loadFile(path.join(__dirname, '..', 'renderer', 'popup.html'));
  popup.on('blur', () => { if (popup) popup.hide(); });
}

// レンダラが報告した内容の高さに合わせてポップアップをリサイズし、再配置する。
function resizePopup(contentHeight) {
  if (!popup || popup.isDestroyed()) return;
  const h = Math.max(120, Math.min(640, Math.round(contentHeight)));
  popup.setSize(POPUP_WIDTH, h, false);
  if (popup.isVisible()) positionPopupNearTray();
}

function positionPopupNearTray() {
  if (!tray || !popup) return;
  const trayBounds = tray.getBounds();
  const winBounds = popup.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  // 画面右端からはみ出さないよう調整
  const maxX = display.workArea.x + display.workArea.width - winBounds.width - 8;
  x = Math.min(Math.max(display.workArea.x + 8, x), maxX);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  popup.setPosition(x, y, false);
}

function togglePopup() {
  if (!popup) createPopup();
  if (popup.isVisible()) {
    popup.hide();
    return;
  }
  positionPopupNearTray();
  popup.show();
  popup.focus();
  sendSnapshot();
}

// --- IPC ------------------------------------------------------------------
function sendSnapshot() {
  const snap = usage.snapshot();
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('snapshot', snap);
    popup.webContents.send('settings', settings);
  }
}

function applyLaunchAtLogin(enabled) {
  // 開発実行（未署名の Electron.app）では login item 登録が拒否される。
  // 現在値と一致していれば呼ばない（無害な ERROR ログを避ける）。
  try {
    const current = app.getLoginItemSettings().openAtLogin;
    if (current === !!enabled) return;
    app.setLoginItemSettings({ openAtLogin: !!enabled });
  } catch { /* noop */ }
}

ipcMain.handle('get-snapshot', () => usage.snapshot());
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('refresh-now', async () => {
  await usage.refresh();
  return usage.snapshot();
});
ipcMain.handle('save-settings', (_e, next) => {
  settings = store.save({ ...settings, ...next });
  usage.setSettings(settings);
  applyLaunchAtLogin(settings.launchAtLogin);
  sendSnapshot();
  // パルス設定の変更を即反映（OFF→停止 / ON かつ稼働中→開始）
  if (pulseActive()) startPulseLoop();
  else stopPulseLoop();
  // trayWindow 等の変更を即メニューバーへ反映
  const snap = lastSnap || (usage && usage.snapshot());
  if (snap) requestTrayRender(snap);
  return settings;
});
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('report-height', (_e, h) => resizePopup(h));

// 隠しレンダラ準備完了 → 初回描画（lastSnap が無ければ現スナップショット）
ipcMain.on('tray-ready', () => {
  trayRendererReady = true;
  const snap = lastSnap || (usage && usage.snapshot());
  if (snap) requestTrayRender(snap);
});

// 合成済み画像を受け取って Tray にセット（テンプレート画像で明暗追従）
ipcMain.on('tray-image', (_e, { dataUrl, width, height }) => {
  if (!tray) return;
  const img = nativeImage.createFromDataURL(dataUrl);
  // 論理サイズを指定して Retina をきれいに縮小。テンプレート化で明暗に追従。
  const resized = img.resize({ width, height });
  resized.setTemplateImage(true);
  tray.setImage(resized);
  tray.setTitle(''); // 画像のみ

  // デバッグ: 生成画像を保存（LIMITPEEK_DEBUG_IMG にパス指定時のみ）
  if (process.env.LIMITPEEK_DEBUG_IMG) {
    try { fs.writeFileSync(process.env.LIMITPEEK_DEBUG_IMG, img.toPNG()); } catch { /* noop */ }
  }
});

// --- 起動 -----------------------------------------------------------------
app.whenReady().then(() => {
  settings = store.load();
  applyLaunchAtLogin(settings.launchAtLogin);

  usage = new UsageStore(settings);
  usage.on('change', (snap) => {
    lastSnap = snap;
    requestTrayRender(snap);
    sendSnapshot();
  });

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle(' Limit');
  tray.setToolTip('LimitPeek — Claude / Codex レートリミット');
  tray.on('click', () => togglePopup());
  tray.on('right-click', () => togglePopup());

  createTrayRenderer();
  createPopup();
  usage.start();

  // セッション稼働の監視 → 状態が変わったらパルスの開始/停止を切り替える。
  sessionDetector = new SessionDetector();
  sessionDetector.on('change', (next) => {
    sessions = next;
    if (pulseActive()) startPulseLoop();
    else stopPulseLoop();
  });
  sessionDetector.start();

  // ダーク/ライト切替時は再描画（テンプレート画像なので色は自動だが、念のため）
  nativeTheme.on('updated', () => { if (lastSnap) requestTrayRender(lastSnap); });
});

app.on('window-all-closed', (e) => {
  // ウィンドウを全部閉じても常駐し続ける
  e.preventDefault();
});
