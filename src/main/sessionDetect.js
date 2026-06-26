'use strict';

// claude / codex の CLI プロセスが「実際に稼働中か」を ps で監視する。
//
// 「稼働中」の定義（誤アニメーションを避けるための仕様）:
//   ・対象プロセスの「累積 CPU 時間」が前回ポーリングから増えていれば稼働中。
//     → ただ開いているだけ（アイドル）のセッションや、LimitPeek を起動した
//        待機中の claude 自身ではアニメーションしない。
//   ・codex の "mcp-server" は常駐プロセスなので、対話セッションではない。除外する。
//
// 状態が変わったときだけ 'change' を emit する。値は { claude:bool, codex:bool }。
//
// なぜ「瞬間 CPU%」ではなく「CPU 時間の差分」で見るか:
//   ・ps の %cpu は「プロセス起動からの累積平均 CPU%」で瞬間値ではない。長く
//     起動しているセッションほど、処理中でも平均が薄まって閾値に届かなくなる。
//   ・claude（Node 製）は処理中に CPU を数〜十数% 食うが、codex の本体は Rust
//     バイナリで重い処理はリモート側にあり、処理中でもローカル CPU% がほぼ
//     上がらない。固定 %cpu 閾値だと codex が永久に「稼働中」にならなかった。
//   ・代わりに「累積 CPU 時間（time 列）」を毎回記録し、ポーリング間隔の間に
//     値が増えたか（= その期間に CPU を実際に消費したか）で判定する。これなら
//     プロバイダごとの CPU 体質差に依存せず、待機中（増分ゼロ）と処理中
//     （増分あり）を素直に分けられる。
//
// 誤検出を避けるための方針:
//   ・comm（実行ファイル）のベース名で判定する。引数全体は使わない。
//     → 引数に "/Users/me/.claude/..." 等を含む無関係プロセスを拾わない。
//   ・CLI は小文字 "claude" / "codex"。デスクトップアプリ "Claude.app"
//     （comm ベース名は chrome-native-host 等、または大文字 Claude）とは区別される。
//   ・codex は node ラッパ（node .../bin/codex ...）経由でも動くため、
//     その場合のみ引数を見て codex サブコマンド起動かを判定する。

const EventEmitter = require('events');
const { execFile } = require('child_process');

// 累積 CPU 時間の増分（秒）がこれ以上なら「実際に稼働中」とみなす。
// アイドルのセッションでも、Node 製の claude は待機中（キー入力待ち）に
// イベントループ・UI 更新・ファイル監視等で 3 秒あたり 0.02〜0.06 秒ほど CPU を
// 食う。一方で実際に処理しているときは 0.4 秒/3 秒前後まで上がる（実測）。
// 両者の間に閾値を置き、アイドルの常駐コストを「稼働中」と誤検出しないようにする。
//   実測（3 秒間隔の増分）: 待機 claude ≈ 0.02〜0.06s / 処理中 claude ≈ 0.4〜0.5s
const CPU_DELTA_THRESHOLD_SEC = 0.15;

// パス文字列のベース名（最後の "/" 以降）を取り出す。
function basename(s) {
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

// node ラッパ経由で起動された codex を引数から拾う。
//   例: node /opt/homebrew/bin/codex mcp-server
//       node /opt/homebrew/lib/.../bin/codex ...
const CODEX_ARG_RE = /[/ ]codex(\s|$)/;

// codex の常駐 MCP サーバーかどうか（対話セッションではないので除外する）。
function isCodexMcpServer(args) {
  return /\bmcp-server\b/.test(args);
}

// このプロセスが claude / codex のどちらの CLI かを判定する。該当しなければ null。
//
// comm（実行ファイル名）は macOS の ps では 16 文字で打ち切られるため、
// パスの長い本体バイナリ（例:
//   /opt/homebrew/lib/node_modules/@openai/codex/.../bin/codex）は
// comm が "/opt/homebrew/li" のように途中で切れて名前判定をすり抜ける。
// そこで打ち切られない args（フルコマンドライン）の「実行ファイル名」を主軸に
// 判定し、comm のベース名は補助として使う。
//
//   ・claude: 実行ファイル名が小文字 "claude"（デスクトップアプリ "Claude.app" は弾く）。
//   ・codex : 実行ファイル名が "codex" 本体、または node ラッパ
//             （node .../bin/codex ...）。ただし常駐 mcp-server は除外。
function classifyProcess(comm, args) {
  // args の第1トークン = 実行ファイルのパス。空なら comm にフォールバック。
  const exec = args ? args.split(' ', 1)[0] : '';
  const execBase = exec ? basename(exec) : '';
  const commBase = basename(comm);

  if (execBase === 'claude' || commBase === 'claude') return 'claude';

  if (!isCodexMcpServer(args)) {
    if (execBase === 'codex' || commBase === 'codex') return 'codex';
    // node ラッパ（node .../bin/codex ...）。comm が切れていても args で拾う。
    if ((execBase === 'node' || commBase === 'node') && CODEX_ARG_RE.test(args)) {
      return 'codex';
    }
  }
  return null;
}

// ps の time 列（[[HH:]MM:]SS.ss 形式）を秒(小数)に変換する。
//   例: "0:01.06" → 1.06 / "13:53.63" → 833.63 / "1:02:03.5" → 3723.5
function parseCpuTime(time) {
  if (!time) return null;
  const parts = time.split(':');
  let sec = 0;
  for (const p of parts) {
    const n = parseFloat(p);
    if (Number.isNaN(n)) return null;
    sec = sec * 60 + n;
  }
  return sec;
}

class SessionDetector extends EventEmitter {
  constructor(intervalMs = 3000) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.state = { claude: false, codex: false };
    this.selfPid = process.pid;
    // pid -> 前回観測した累積 CPU 時間(秒)。差分計算に使う。
    this.prevCpuTime = new Map();
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
    // pid time comm args の順で取得する。time は累積 CPU 時間（[[HH:]MM:]SS.ss）。
    execFile(
      'ps',
      ['-axo', 'pid=,time=,comm=,args='],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return; // 失敗時は前回状態を保持
        let claude = false;
        let codex = false;
        const nextCpuTime = new Map();

        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // "pid time comm args..." を分解。pid/time/comm にスペースは無い前提。
          const sp1 = trimmed.indexOf(' ');
          if (sp1 < 0) continue;
          const pid = Number(trimmed.slice(0, sp1));
          if (pid === this.selfPid) continue; // 自分（main プロセス）は除外

          const afterPid = trimmed.slice(sp1 + 1).replace(/^\s+/, '');
          const sp2 = afterPid.indexOf(' ');
          if (sp2 < 0) continue;
          const cpuTime = parseCpuTime(afterPid.slice(0, sp2));
          if (cpuTime == null) continue;

          const afterTime = afterPid.slice(sp2 + 1).replace(/^\s+/, '');
          const sp3 = afterTime.indexOf(' ');
          const comm = sp3 < 0 ? afterTime : afterTime.slice(0, sp3);
          const args = sp3 < 0 ? '' : afterTime.slice(sp3 + 1);

          // このプロセスが claude / codex のどちらの対象かを先に判定する。
          // （対象プロセスだけ CPU 時間を記録し、無関係プロセスは無視する）
          const kind = classifyProcess(comm, args);
          if (!kind) continue;

          nextCpuTime.set(pid, cpuTime);

          // 前回の累積 CPU 時間より増えていれば、この間隔で実際に処理した。
          const prev = this.prevCpuTime.get(pid);
          const active = prev != null && cpuTime - prev >= CPU_DELTA_THRESHOLD_SEC;
          if (!active) continue;

          if (kind === 'claude') claude = true;
          else codex = true;
        }

        // 次回の差分計算に備えて、対象プロセスの CPU 時間を保存する。
        this.prevCpuTime = nextCpuTime;

        const changed = claude !== this.state.claude || codex !== this.state.codex;
        this.state = { claude, codex };
        if (changed) this.emit('change', this.current());
      }
    );
  }
}

module.exports = {
  SessionDetector,
  _internals: { CPU_DELTA_THRESHOLD_SEC, parseCpuTime, classifyProcess },
};
