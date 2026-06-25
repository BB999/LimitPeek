'use strict';

// Claude Code のレートリミット使用率を取得するプロバイダ。
//
// 認証情報の在り処は環境によって複数ある:
//   1) ~/.claude/.credentials.json （ファイル。全 OS 共通の第一候補）
//   2) macOS Keychain （サービス名 "Claude Code-credentials"）
//   3) Windows 資格情報マネージャ （ターゲット名 "Claude Code-credentials"）
// まずファイルを見て、無ければ OS ごとの安全な保管庫を見る。
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
// macOS Keychain のサービス名 / Windows 資格情報マネージャのターゲット名（共通）
const CREDENTIAL_TARGET = 'Claude Code-credentials';

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

// macOS Keychain から読む（security コマンド）。
function readCredentialsFromKeychain() {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', CREDENTIAL_TARGET, '-w'],
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

// Windows 資格情報マネージャから読む。
// cmdkey ではパスワード本体が取れないため PowerShell + CredentialManager を使う。
// 標準では CredentialManager モジュールが無いこともあるので、Win32 API を
// PowerShell から直接叩く（追加インストール不要）。Generic 資格情報を対象にする。
function readCredentialsFromWinCred() {
  // ターゲット名は claude code 本体が書く想定。複数候補を順に当たる。
  const targets = [CREDENTIAL_TARGET, 'Claude Code', 'claude'];
  // PowerShell スクリプト: CredRead(Win32) で blob を取り、UTF-8 文字列にして出力。
  const ps = `
$ErrorActionPreference='Stop'
$sig=@'
using System;
using System.Runtime.InteropServices;
public class CredMan {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp | Out-Null
$targets = @(${targets.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})
foreach ($t in $targets) {
  $p=[IntPtr]::Zero
  if ([CredMan]::CredRead($t,1,0,[ref]$p)) {
    $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][CredMan+CREDENTIAL])
    if ($c.CredentialBlobSize -gt 0) {
      $bytes=New-Object byte[] $c.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$bytes,0,$c.CredentialBlobSize)
      [CredMan]::CredFree($p)
      [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
      exit 0
    }
    [CredMan]::CredFree($p)
  }
}
exit 1
`.trim();

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
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
  // 全 OS 共通: まずファイルを見る
  const fromFile = readCredentialsFromFile();
  if (fromFile) return fromFile;
  // OS ごとの安全な保管庫にフォールバック
  if (process.platform === 'darwin') return await readCredentialsFromKeychain();
  if (process.platform === 'win32') return await readCredentialsFromWinCred();
  return null;
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
