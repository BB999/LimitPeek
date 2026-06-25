'use strict';

// Claude Code のレートリミット使用率を取得するプロバイダ。
//
// 認証情報の在り処は環境によって2通りある:
//   1) ~/.claude/.credentials.json （ファイル）
//   2) macOS Keychain （サービス名 "Claude Code-credentials"）
// この環境はファイルが無く Keychain に入っているため、両対応する。
//
// エンドポイント: GET https://api.anthropic.com/api/oauth/usage
//   - Authorization: Bearer <accessToken>
//   - anthropic-beta: oauth-2025-04-20    （無いと 401）
//   - User-Agent: claude-code/<version>   （無いと即 429 で詰む。これが肝）
//
// /api/oauth/usage は設計上ポーリングに弱く 429 を返しやすい。
// 呼び出し側で最小間隔・バックオフ・前回値キャッシュを必ず効かせること。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
// 実在しそうな claude-code の UA。429 回避のため必須。
const USER_AGENT = 'claude-code/2.1.69 (external; limitpeek)';

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// --- 認証情報の取得 -------------------------------------------------------

function readCredentialsFromFile() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    const json = JSON.parse(raw);
    return json.claudeAiOauth || null;
  } catch {
    return null;
  }
}

function readCredentialsFromKeychain() {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const json = JSON.parse(stdout.trim());
          resolve(json.claudeAiOauth || null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function getOAuth() {
  return readCredentialsFromFile() || (await readCredentialsFromKeychain());
}

// --- レスポンス正規化 -----------------------------------------------------
// API のレスポンス形は時期・記事により表記揺れがある。観測される代表形:
//   A) { five_hour: {utilization, resets_at}, seven_day: {...} }      utilization は 0..1
//   B) { usage: { windows: { "5h": {used_percent}, "7d": {...} } } }  percent は 0..100
//   C) { five_hour: {utilization}, seven_day: {...}, seven_day_oauth_apps: {...} }
// どれが来ても 0..100 の % に正規化して返す。

function toPercent(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  // 0..1 の比率なら % に変換、すでに % っぽければそのまま。
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
}

function toResetMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    // Unix 秒 or ミリ秒のどちらか。秒なら ms 化。
    return value < 1e12 ? value * 1000 : value;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// 1つの窓 {utilization|used_percent, resets_at|resetsAt} -> {usedPercent, resetMs}
function normalizeWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const pct = toPercent(
    win.utilization ?? win.used_percent ?? win.usedPercent ?? win.percent
  );
  if (pct == null) return null;
  const resetMs = toResetMs(win.resets_at ?? win.resetsAt ?? win.reset_at);
  return { usedPercent: pct, resetMs };
}

function normalizeUsage(body) {
  const root = body && body.usage ? body.usage : body || {};
  const windows = root.windows || {};

  const fiveHour =
    normalizeWindow(root.five_hour) ||
    normalizeWindow(windows['5h']) ||
    normalizeWindow(windows.five_hour);

  const sevenDay =
    normalizeWindow(root.seven_day) ||
    normalizeWindow(windows['7d']) ||
    normalizeWindow(windows.seven_day);

  return { fiveHour, sevenDay };
}

// --- 公開 API -------------------------------------------------------------

// 戻り値:
//   { ok:true, fiveHour:{usedPercent,resetMs}, sevenDay:{...} }
//   { ok:false, reason:'not_logged_in'|'auth_expired'|'rate_limited'|'network'|'parse', detail }
async function fetchClaudeUsage() {
  const oauth = await getOAuth();
  if (!oauth || !oauth.accessToken) {
    return { ok: false, reason: 'not_logged_in' };
  }

  // 期限切れの事前判定（refresh は今は未対応 → 要再ログイン表示に留める）
  if (oauth.expiresAt && Date.now() > Number(oauth.expiresAt)) {
    return { ok: false, reason: 'auth_expired' };
  }

  let res;
  try {
    res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': BETA_HEADER,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e && e.message) };
  }

  if (res.status === 401) return { ok: false, reason: 'auth_expired' };
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || null;
    return { ok: false, reason: 'rate_limited', retryAfterSec: retryAfter };
  }
  if (!res.ok) {
    return { ok: false, reason: 'network', detail: `HTTP ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: 'parse', detail: String(e && e.message) };
  }

  const { fiveHour, sevenDay } = normalizeUsage(body);
  if (!fiveHour && !sevenDay) {
    return { ok: false, reason: 'parse', detail: 'unknown response shape', raw: body };
  }
  return { ok: true, fiveHour, sevenDay };
}

module.exports = { fetchClaudeUsage, _internals: { normalizeUsage, getOAuth } };
