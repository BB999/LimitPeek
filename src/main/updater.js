'use strict';

// GitHub Releases ベースの自動更新（コード署名・課金 不要）。
//
// electron-updater(Squirrel.Mac) は Developer ID 署名が必須で本アプリ（ad-hoc 署名）
// では使えない。そこで GitHub Releases の zip を自前で DL → 展開 → ad-hoc 署名し直し
// → 既存 .app と差し替え → 再起動する方式を採る。これなら無料・無署名で完結する。

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { app } = require('electron');

const REPO = 'BB999/LimitPeek';
const UA = 'LimitPeek-Updater';

// "v0.3.2" / "0.3.2" → [0,3,2]。比較できない形は null。
function parseVer(s) {
  if (!s) return null;
  const m = String(s).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// a が b より新しければ +1 / 古ければ -1 / 同じ 0。比較不能は 0。
function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

// HTTPS GET（リダイレクト追従）。JSON 文字列を resolve。
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGetJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// HTTPS GET でファイルへ保存（リダイレクト追従）。
function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadTo(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

// child_process を Promise 化（外部コマンド実行用）。
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

// 最新リリースを取得し、更新の有無を判定する。
// 返り値: { available, current, latest, url, name } / 取得失敗時は throw。
async function checkForUpdate() {
  const current = app.getVersion();
  const body = await httpsGetJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const rel = JSON.parse(body);
  const latest = (rel.tag_name || rel.name || '').replace(/^v/i, '');
  // mac-arm64 の zip 資産を拾う。無ければ最初の .zip。
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const zip =
    assets.find((a) => /\.zip$/i.test(a.name) && /arm64|mac/i.test(a.name)) ||
    assets.find((a) => /\.zip$/i.test(a.name));
  const available = cmpVer(latest, current) > 0 && !!zip;
  return {
    available,
    current,
    latest,
    url: zip ? zip.browser_download_url : null,
    name: zip ? zip.name : null,
  };
}

// 現在動作中の .app バンドルの絶対パス（/Applications/LimitPeek.app など）。
// app.getPath('exe') は .../LimitPeek.app/Contents/MacOS/LimitPeek を指す。
function currentAppBundlePath() {
  const exe = app.getPath('exe');
  const idx = exe.indexOf('.app/');
  if (idx === -1) return null;
  return exe.slice(0, idx + 4); // ".app" まで
}

// 更新をダウンロード→展開→ad-hoc署名→既存 .app と差し替え→再起動。
// 開発実行（未パッケージ）では差し替え先が Electron.app になるため拒否する。
// 進捗を onProgress(stage) で通知する（stage: 'download'|'verify'|'swap'|'relaunch'）。
async function downloadAndInstall(info, onProgress = () => {}) {
  if (!app.isPackaged) {
    throw new Error('dev_mode'); // 開発実行では自動更新しない
  }
  const bundle = currentAppBundlePath();
  if (!bundle) throw new Error('bundle_not_found');
  if (!info || !info.url) throw new Error('no_asset');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'limitpeek-upd-'));
  const zipPath = path.join(work, info.name || 'update.zip');

  try {
    onProgress('download');
    await downloadTo(info.url, zipPath);

    onProgress('verify');
    // zip 展開（macOS 標準の ditto。署名・属性を保持）
    const extractDir = path.join(work, 'extracted');
    fs.mkdirSync(extractDir);
    await run('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

    // 展開先から .app を探す
    const found = fs.readdirSync(extractDir).find((n) => n.endsWith('.app'));
    if (!found) throw new Error('app_not_in_zip');
    const newApp = path.join(extractDir, found);

    // ad-hoc 署名し直して整合させる（壊れている扱いを防ぐ）
    await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', newApp]);
    // 検証（通らなければ差し替えない）
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);

    onProgress('swap');
    // 既存 .app を退避 → 新 .app を所定の場所へ移動 → 退避を削除。
    const parent = path.dirname(bundle);
    const backup = path.join(parent, `.${path.basename(bundle)}.bak-${process.pid}`);
    // 既存退避（同一ボリューム間の rename は高速・原子的）
    fs.renameSync(bundle, backup);
    try {
      // 別ボリューム(tmp)→対象 への移動は ditto でコピー（rename は EXDEV になり得る）
      await run('/usr/bin/ditto', [newApp, bundle]);
    } catch (e) {
      // 失敗したらロールバック
      try { fs.rmSync(bundle, { recursive: true, force: true }); } catch { /* noop */ }
      fs.renameSync(backup, bundle);
      throw e;
    }
    // quarantine 属性を念のため除去（ローカル展開なので付かないはずだが保険）
    try { await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle]); } catch { /* noop */ }
    // 退避を削除
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* noop */ }

    // 差し替えまで完了。再起動は呼び出し側（main）がタイマー停止後に行う。
    // ここで relaunch/exit すると、稼働中のタイマーが破棄済みオブジェクトを
    // 参照してクラッシュするため、責務を分離している。
    return { ok: true };
  } finally {
    // 作業ディレクトリ後始末
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

// 新バイナリで再起動する。呼び出し側が全タイマー・ウィンドウを片付けてから呼ぶこと。
function relaunchApp() {
  app.relaunch();
  app.exit(0);
}

module.exports = { checkForUpdate, downloadAndInstall, relaunchApp, cmpVer, parseVer };
