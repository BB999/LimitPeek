'use strict';

// --- 多言語辞書 ---
const I18N = {
  ja: {
    // 固定UIテキスト（data-i18n）
    refresh: '今すぐ更新',
    refreshing: '更新中…',
    quit: '終了',
    interval: '更新間隔',
    intervalHint: '1〜30 分',
    min: '分',
    watchClaude: 'Claude Code を監視',
    watchCodex: 'Codex を監視',
    launchAtLogin: 'ログイン時に自動起動',
    pulseOnSession: '稼働中アニメーション',
    pulseOnSessionHint: 'セッション中ロゴがもこもこ動く',
    trayContent: '表示内容',
    contentBoth: 'バー+数字',
    contentBar: 'バー',
    contentPct: '数字',
    trayWindow: 'メニューバー表示',
    both: '両方',
    language: '言語',
    saved: '保存しました',
    // 動的テキスト
    watchOff: '監視オフ',
    updatedPrefix: '更新',
    resetPrefix: 'リセット',
    locale: 'ja-JP',
    reason: {
      not_logged_in: '未ログイン',
      auth_expired: '要再ログイン',
      rate_limited: '取得失敗（前回値）',
      network: '取得失敗（前回値）',
      parse: '形式エラー',
      not_installed: 'codex 未検出',
      spawn_error: '起動エラー',
      timeout: 'タイムアウト',
      no_data: 'データなし',
      idle: '取得中…',
    },
  },
  en: {
    refresh: 'Refresh now',
    refreshing: 'Refreshing…',
    quit: 'Quit',
    interval: 'Update interval',
    intervalHint: '1–30 min',
    min: 'min',
    watchClaude: 'Watch Claude Code',
    watchCodex: 'Watch Codex',
    launchAtLogin: 'Launch at login',
    pulseOnSession: 'Pulse while active',
    pulseOnSessionHint: 'Logo pulses during a session',
    trayContent: 'Show as',
    contentBoth: 'Bar+%',
    contentBar: 'Bar',
    contentPct: '%',
    trayWindow: 'Menu bar shows',
    both: 'Both',
    language: 'Language',
    saved: 'Saved',
    watchOff: 'Off',
    updatedPrefix: 'Updated',
    resetPrefix: 'Resets',
    locale: 'en-US',
    reason: {
      not_logged_in: 'Not logged in',
      auth_expired: 'Re-login required',
      rate_limited: 'Fetch failed (cached)',
      network: 'Fetch failed (cached)',
      parse: 'Parse error',
      not_installed: 'codex not found',
      spawn_error: 'Spawn error',
      timeout: 'Timeout',
      no_data: 'No data',
      idle: 'Loading…',
    },
  },
};

let lang = 'ja';
let trayWin = '5h'; // メニューバー表示窓 '5h' | '7d' | 'both'
let trayContent = 'both'; // メニューバー表示内容 'both' | 'bar' | 'pct'
const t = () => I18N[lang] || I18N.ja;

// 最新スナップショットを保持（言語切替時に再描画するため）
let lastSnap = null;

function barColor(pct) {
  if (pct >= 90) return 'var(--bar-hot)';
  if (pct >= 50) return 'var(--bar-warn)';
  return 'var(--bar)';
}

function fmtReset(ms) {
  if (!ms) return '';
  const loc = t().locale;
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `${t().resetPrefix} ${time}`;
  const date = d.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' });
  return `${t().resetPrefix} ${date} ${time}`;
}

function windowRow(label, win) {
  const pct = win ? Math.round(win.usedPercent * 10) / 10 : null;
  const pctText = pct == null ? '—' : `${pct}%`;
  const reset = win ? fmtReset(win.resetMs) : '';
  const w = pct == null ? 0 : Math.min(100, pct);
  return `
    <div class="row">
      <div class="row-top">
        <span>${label}<span style="margin-left:8px">${reset}</span></span>
        <span class="pct">${pctText}</span>
      </div>
      <div class="track"><div class="fill" style="width:${w}%;background:${barColor(w)}"></div></div>
    </div>`;
}

function renderService(elId, title, svc) {
  const el = document.getElementById(elId);
  if (!svc.enabled) {
    el.className = 'svc disabled';
    el.innerHTML = `<div class="svc-head"><span class="svc-name">${title}</span><span class="svc-note">${t().watchOff}</span></div>`;
    return;
  }
  el.className = 'svc';
  const note = svc.error ? (t().reason[svc.error] || svc.error) : '';

  const data = svc.data || {};
  el.innerHTML = `
    <div class="svc-head">
      <span class="svc-name">${title}</span>
      <span class="svc-note">${note}</span>
    </div>
    ${windowRow('5h', data.fiveHour)}
    ${windowRow('7d', data.sevenDay)}`;
}

function render(snap) {
  if (snap) lastSnap = snap;
  if (!lastSnap) return;
  renderService('claude', 'Claude Code', lastSnap.claude);
  renderService('codex', 'Codex', lastSnap.codex);

  const times = [lastSnap.claude.updatedAt, lastSnap.codex.updatedAt].filter(Boolean);
  const last = times.length ? Math.max(...times) : null;
  const updated = document.getElementById('updated');
  updated.textContent = last
    ? `${t().updatedPrefix} ${new Date(last).toLocaleTimeString(t().locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : '';
  reportHeight();
}

// --- ポップアップの高さをメインへ通知（内容に応じて自動リサイズ） ---
function reportHeight() {
  // 次フレームでレイアウト確定後に測る
  requestAnimationFrame(() => {
    const h = Math.ceil(document.body.scrollHeight);
    if (window.api.reportHeight) window.api.reportHeight(h);
  });
}

// --- 言語の適用（固定UIテキスト＋言語ボタンの選択状態＋動的部分の再描画） ---
function applyLang() {
  const dict = t();
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] != null) el.textContent = dict[key];
  });
  document.querySelectorAll('#langSeg .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });
  render(); // note・リセット時刻・更新時刻を新しい言語で描き直す
}

// --- メニューバー表示窓セグメントの選択状態を反映 ---
function applyTrayWin() {
  document.querySelectorAll('#traySeg .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-win') === trayWin);
  });
}

// --- メニューバー表示内容セグメントの選択状態を反映 ---
function applyContent() {
  document.querySelectorAll('#contentSeg .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-content') === trayContent);
  });
}

// --- 使用率アクション ---
document.getElementById('refresh').addEventListener('click', async () => {
  const btn = document.getElementById('refresh');
  btn.textContent = t().refreshing;
  const snap = await window.api.refreshNow();
  render(snap);
  btn.textContent = t().refresh;
});
document.getElementById('quit').addEventListener('click', () => window.api.quit());

// --- 設定パネル（常時表示） ---
const $interval = document.getElementById('interval');
const $watchClaude = document.getElementById('watchClaude');
const $watchCodex = document.getElementById('watchCodex');
const $login = document.getElementById('launchAtLogin');
const $pulse = document.getElementById('pulseOnSession');
const $setSaved = document.getElementById('setSaved');

let saveTimer = null;

function fillSettings(s) {
  $interval.value = s.intervalMin;
  $watchClaude.checked = s.watchClaude;
  $watchCodex.checked = s.watchCodex;
  $login.checked = s.launchAtLogin;
  $pulse.checked = s.pulseOnSession;
  if (s.lang && s.lang !== lang) {
    lang = s.lang;
    applyLang();
  }
  if (s.trayWindow && s.trayWindow !== trayWin) {
    trayWin = s.trayWindow;
    applyTrayWin();
  }
  if (s.trayContent && s.trayContent !== trayContent) {
    trayContent = s.trayContent;
    applyContent();
  }
}

async function saveSettings() {
  let intervalMin = parseInt($interval.value, 10);
  if (Number.isNaN(intervalMin)) intervalMin = 5;
  intervalMin = Math.min(30, Math.max(1, intervalMin));
  $interval.value = intervalMin;

  const saved = await window.api.saveSettings({
    intervalMin,
    watchClaude: $watchClaude.checked,
    watchCodex: $watchCodex.checked,
    launchAtLogin: $login.checked,
    pulseOnSession: $pulse.checked,
    lang,
    trayWindow: trayWin,
    trayContent,
  });
  fillSettings(saved);
  $setSaved.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => $setSaved.classList.remove('show'), 1200);
}

[$interval, $watchClaude, $watchCodex, $login, $pulse].forEach((el) => {
  el.addEventListener('change', saveSettings);
});

// --- メニューバー表示窓 切替ボタン ---
document.getElementById('traySeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const next = btn.getAttribute('data-win');
  if (next === trayWin) return;
  trayWin = next;
  applyTrayWin();
  saveSettings(); // 永続化＋メニューバー即反映
});

// --- メニューバー表示内容 切替ボタン ---
document.getElementById('contentSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const next = btn.getAttribute('data-content');
  if (next === trayContent) return;
  trayContent = next;
  applyContent();
  saveSettings(); // 永続化＋メニューバー即反映
});

// --- 言語切替ボタン ---
document.getElementById('langSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const next = btn.getAttribute('data-lang');
  if (next === lang) return;
  lang = next;
  applyLang();
  saveSettings(); // 永続化
});

// --- 受信 ---
window.api.onSnapshot(render);
window.api.onSettings(fillSettings);
window.api.getSnapshot().then(render);
window.api.getSettings().then(fillSettings);

// 初期表示（保存済み設定が来る前のデフォルト適用）
applyLang();
applyTrayWin();
applyContent();
