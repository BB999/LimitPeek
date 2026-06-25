'use strict';

// Codex のレートリミット使用率を取得するプロバイダ。
//
// `codex app-server` を子プロセスで起動し、stdio 越しに JSON-RPC で会話する。
// トランスポートは改行区切り JSON (JSONL)。Content-Length ヘッダは使わない。
//
// ハンドシェイク順序（公式 app-server README 準拠）:
//   1) initialize リクエスト送信
//   2) initialize レスポンス受信
//   3) initialized 通知送信
//   4) account/rateLimits/read 送信 → レスポンス受信
//
// レスポンス: result.rateLimits.primary (5h) / .secondary (7d)
//   各 { usedPercent, windowDurationMins, resetsAt(Unix秒) }
// ※ account/rateLimits/read は experimental 扱い（公式 README 未記載）。
//    codex のバージョン更新で形が変わりうる点に注意。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// codex CLI が置かれがちな場所（Homebrew / npm global / nvm 等）。
const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.volta', 'bin'),
];

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function resolveCodexBin() {
  if (process.env.CODEX_BIN && existsFile(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  for (const dir of COMMON_BIN_DIRS) {
    const cand = path.join(dir, 'codex');
    if (existsFile(cand)) return cand;
  }
  // 最後の手段: PATH 任せ（spawn が PATH から探す）
  return 'codex';
}

// .app を Finder から開くと PATH が最小限になり、codex（#!/usr/bin/env node の
// スクリプト）が node を見つけられず起動に失敗する。
// そこで子プロセスには共通 bin ディレクトリを足した PATH を明示的に渡す。
function buildChildEnv() {
  const extra = COMMON_BIN_DIRS.join(':');
  const base = process.env.PATH || '';
  return { ...process.env, PATH: extra + (base ? ':' + base : '') };
}

function toResetMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function normalizeWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const pct = win.usedPercent ?? win.used_percent;
  if (pct == null) return null;
  return {
    usedPercent: Math.round(Number(pct) * 10) / 10,
    resetMs: toResetMs(win.resetsAt ?? win.resets_at),
    windowMins: win.windowDurationMins ?? win.window_duration_mins ?? null,
  };
}

// 戻り値:
//   { ok:true, fiveHour:{usedPercent,resetMs}, sevenDay:{...}, planType? }
//   { ok:false, reason:'not_installed'|'spawn_error'|'timeout'|'no_data'|'parse', detail }
function fetchCodexUsage({ timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const bin = resolveCodexBin();
    let child;
    try {
      child = spawn(bin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(),
      });
    } catch (e) {
      return resolve({ ok: false, reason: 'spawn_error', detail: String(e && e.message) });
    }

    let settled = false;
    let buf = '';
    let stderr = '';
    let initialized = false;

    const INIT_ID = 0;
    const RATE_ID = 1;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* noop */ }
      resolve(result);
    };

    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n');
      } catch (e) {
        finish({ ok: false, reason: 'spawn_error', detail: String(e && e.message) });
      }
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', detail: stderr.slice(-400) || null });
    }, timeoutMs);

    child.on('error', (e) => {
      const enoent = e && e.code === 'ENOENT';
      finish({
        ok: false,
        reason: enoent ? 'not_installed' : 'spawn_error',
        detail: String(e && e.message),
      });
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // JSON 以外の行（ログ等）は無視
        }
        handleMessage(msg);
      }
    });

    function handleMessage(msg) {
      // initialize レスポンス
      if (msg.id === INIT_ID && msg.result !== undefined && !initialized) {
        initialized = true;
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: RATE_ID, params: {} });
        return;
      }

      // rateLimits レスポンス
      if (msg.id === RATE_ID) {
        if (msg.error) {
          return finish({
            ok: false,
            reason: 'no_data',
            detail: msg.error.message || JSON.stringify(msg.error),
          });
        }
        const result = msg.result || {};
        const rl = result.rateLimits || result.rate_limits || {};
        const fiveHour = normalizeWindow(rl.primary);
        const sevenDay = normalizeWindow(rl.secondary);
        if (!fiveHour && !sevenDay) {
          return finish({ ok: false, reason: 'no_data', detail: 'empty rateLimits', raw: result });
        }
        return finish({
          ok: true,
          fiveHour,
          sevenDay,
          planType: result.planType || result.plan_type || null,
        });
      }
    }

    // ハンドシェイク開始
    send({
      method: 'initialize',
      id: INIT_ID,
      params: {
        clientInfo: { name: 'limitpeek', title: 'LimitPeek', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

module.exports = { fetchCodexUsage, _internals: { normalizeWindow } };
