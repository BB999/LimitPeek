'use strict';

// claude / codex の CLI プロセスが「実際に稼働中か」を ps で監視する。
//
// 「稼働中」の定義（誤アニメーションを避けるための仕様）:
//   ・対象プロセスのうち CPU 使用率が閾値以上のものが 1 つでもあれば稼働中。
//     → ただ開いているだけ（アイドル）のセッションや、LimitPeek を起動した
//        待機中の claude 自身ではアニメーションしない。
//   ・codex の "mcp-server" は常駐プロセスなので、対話セッションではない。除外する。
//
// 状態が変わったときだけ 'change' を emit する。値は { claude:bool, codex:bool }。
//
// 誤検出を避けるための方針:
//   ・comm（実行ファイル）のベース名で判定する。引数全体は使わない。
//     → 引数に "/Users/me/.claude/..." 等を含む無関係プロセスを拾わない。
//   ・CLI は小文字 "claude" / "codex"。デスクトップアプリ "Claude.app"
//     （comm ベース名は chrome-native-host 等、または大文字 Claude）とは区別される。
//   ・codex は node ラッパ（node .../bin/codex ...）経由でも動くため、
//     その場合のみ引数を見て codex サブコマンド起動かを判定する。
//
// 注意: ps の %cpu は「プロセス起動からの累積平均 CPU%」で瞬間値ではない。
//   アイドルのセッションは概ね 0〜0.5% に収まり、推論・処理中は数〜十数% に上がる。
//   閾値はこの差を分けられる値（既定 4%）にしてある。

const EventEmitter = require('events');
const { execFile } = require('child_process');

// CPU 使用率の閾値(%)。これ以上なら「実際に稼働中」とみなす。
const CPU_THRESHOLD = 4;

// comm のベース名（最後の "/" 以降）を取り出す。
function basename(comm) {
  const i = comm.lastIndexOf('/');
  return i < 0 ? comm : comm.slice(i + 1);
}

// node ラッパ経由で起動された codex を引数から拾う。
//   例: node /opt/homebrew/bin/codex mcp-server
//       node /opt/homebrew/lib/.../bin/codex ...
const CODEX_ARG_RE = /[/ ]codex(\s|$)/;

// codex の常駐 MCP サーバーかどうか（対話セッションではないので除外する）。
function isCodexMcpServer(args) {
  return /\bmcp-server\b/.test(args);
}

class SessionDetector extends EventEmitter {
  constructor(intervalMs = 3000) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.state = { claude: false, codex: false };
    this.selfPid = process.pid;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current() {
    return { ...this.state };
  }

  poll() {
    // pid %cpu comm args の順で取得する。%cpu は累積平均（小数）。
    execFile(
      'ps',
      ['-axo', 'pid=,%cpu=,comm=,args='],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return; // 失敗時は前回状態を保持
        let claude = false;
        let codex = false;

        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // "pid %cpu comm args..." を分解。pid/%cpu/comm にスペースは無い前提。
          const sp1 = trimmed.indexOf(' ');
          if (sp1 < 0) continue;
          const pid = Number(trimmed.slice(0, sp1));
          if (pid === this.selfPid) continue; // 自分（main プロセス）は除外

          const afterPid = trimmed.slice(sp1 + 1).replace(/^\s+/, '');
          const sp2 = afterPid.indexOf(' ');
          if (sp2 < 0) continue;
          const cpu = parseFloat(afterPid.slice(0, sp2));

          const afterCpu = afterPid.slice(sp2 + 1).replace(/^\s+/, '');
          const sp3 = afterCpu.indexOf(' ');
          const comm = sp3 < 0 ? afterCpu : afterCpu.slice(0, sp3);
          const args = sp3 < 0 ? '' : afterCpu.slice(sp3 + 1);
          const base = basename(comm);

          // CPU 閾値未満は「動いていない」とみなしてスキップ。
          if (!(cpu >= CPU_THRESHOLD)) continue;

          // claude: 小文字 "claude" 限定（デスクトップアプリ "Claude.app" は弾く）。
          if (!claude && base === 'claude') claude = true;

          // codex: 本体 or node ラッパ。ただし常駐 MCP サーバーは除外。
          if (!codex && !isCodexMcpServer(args)) {
            if (base === 'codex') codex = true;
            else if (base === 'node' && CODEX_ARG_RE.test(args)) codex = true;
          }

          if (claude && codex) break;
        }

        const changed = claude !== this.state.claude || codex !== this.state.codex;
        this.state = { claude, codex };
        if (changed) this.emit('change', this.current());
      }
    );
  }
}

module.exports = { SessionDetector, _internals: { CPU_THRESHOLD } };
