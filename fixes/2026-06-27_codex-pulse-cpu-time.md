# Codex 稼働中なのにロゴがパルスしない（+ Claude の誤パルス）

## 問題
1. ターミナルで Codex CLI を普通に起動して動かしているのに、メニューバーの
   Codex ロゴがパルス（稼働中アニメ）しなかった。Claude は光る。
2. （上記修正の過程で判明）待機中の Claude セッションがあると、使っていなくても
   Claude ロゴがパルスしてしまった。

## 原因

### A. 稼働判定が CPU% 閾値方式で、Codex に構造的に合わなかった
旧 `src/main/sessionDetect.js` は「累積平均 CPU%（ps の %cpu）が 4% 以上か」で
判定していた。claude（Node 製）は処理中に CPU を 7〜13% 食うので拾えるが、
codex の本体は Rust バイナリで重い処理はリモート(API)側にあり、処理中でも
ローカル CPU% がほぼ上がらない。→ 固定 %cpu 閾値では codex が永久に稼働中に
ならなかった。

### B. comm の 16 文字打ち切りで Codex 本体プロセスを取りこぼしていた
macOS の `ps` は `comm` 列を 16 文字で打ち切る。Codex 本体の実行パスは
`/opt/homebrew/lib/node_modules/@openai/codex/.../bin/codex` と長く、comm が
`/opt/homebrew/li` に切れて basename が `li` になり、名前判定をすり抜けていた
（CPU を実際に消費するのはこの本体プロセス）。CPU% 方式でも CPU 時間方式でも、
このプロセスを拾えなければ Codex は稼働検出できない。

### C. CPU 時間の閾値が低すぎて、待機中 claude を誤検出した
CPU 時間差分方式へ移行した直後の閾値 `0.05秒` は低すぎた。Node 製の claude は
待機中（キー入力待ち）でもイベントループ・UI 更新・ファイル監視等で
3 秒あたり 0.02〜0.06 秒ほど CPU を食うため、これを「稼働中」と誤検出した。

## 修正（`src/main/sessionDetect.js`）

判定を「瞬間 CPU%」から「累積 CPU 時間（ps の time 列）の差分」へ全面変更し、
Claude / Codex を同一ロジックで判定する。

1. `ps` 取得列を `%cpu` → `time`（`pid=,time=,comm=,args=`）。
2. `parseCpuTime()`: `[[HH:]MM:]SS.ss` を秒(小数)へ変換
   （`"0:01.06"→1.06` / `"13:53.63"→833.63` / `"1:02:03.5"→3723.5`）。
3. `prevCpuTime: Map<pid, 秒>` を持ち、ポーリングごとに対象プロセスの CPU 時間を
   記録。**pid ごとに独立して**前回比の増分を取り、閾値以上なら稼働中と判定。
   → セッション数が増えても各 pid を独立判定するため、増分の「合算」で閾値を
     超える誤検出は構造的に起きない（アイドル 10 個並べても false を実証）。
4. **B の対策**: `classifyProcess(comm, args)` を新設。comm は打ち切られるため、
   打ち切られない args（フルコマンドライン）の第 1 トークン（実行ファイルパス）の
   basename を主軸に claude/codex を判定し、comm の basename は補助に使う。
   codex `mcp-server` 除外・小文字 `claude` 限定・node ラッパ判定は維持。
5. **C の対策**: `CPU_DELTA_THRESHOLD_SEC = 0.15`（秒）。実測で待機 claude の増分は
   最大 0.05s/3s、処理中は 0.25〜0.5s/3s。両者の間に閾値を置き、待機の常駐コストを
   稼働中と誤検出しないようにした（待機上限 0.05 に対し 3 倍のマージン）。

インターフェース（`new SessionDetector()` / `on('change')` / `current()`）は不変
なので `src/main/main.js` 側は無修正。

注意（仕様）: 初回ポーリングは基準取り込みのみで必ず全プロバイダ非稼働。
2 回目以降（起動 ~3 秒後）から差分で判定される。

## 検証
- `parseCpuTime` ユニット: HH:MM:SS / MM:SS / 0 / 不正入力 の 7 ケース全 PASS。
- `classifyProcess` ユニット: comm 打ち切りの codex 本体・node ラッパ codex・
  codex 本体・mcp-server 除外（本体/ラッパ両方）・claude・Claude.app 除外・
  無関係プロセスの 9 ケース全 PASS。
- モック統合テスト:
  - poll#1 基準 → `{claude:false, codex:false}`
  - poll#2 codex +0.30s → `{claude:false, codex:true}`（本丸）
  - poll#3 claude +1.00s → `{claude:true, codex:false}`
  - poll#4 両者 +0.01s（閾値未満）→ `{claude:false, codex:false}`
  - アイドル claude 10 個（合計増分 0.2s）→ `{claude:false}`（合算誤爆なし）
- 実プロセス＋実アプリ:
  - 修正前は Codex 処理中でもログに `codex:true` が一度も出なかった。
  - 修正後（B 対策込み）は Codex 処理中に `{claude:true, codex:true}` を確認。
  - 閾値 0.15 化後、待機中の別 claude セッション（増分 0.02〜0.05s）は
    `claude:false` のままになることを 10 回サンプリングで確認。
