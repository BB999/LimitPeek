# セッション稼働パルスが「動いてないのにアニメする」

## 問題
メニューバーのロゴを「セッション稼働中にパルス（ふわっと拡縮）」させる機能で、
実際には Claude / Codex を使っていないのにアニメーションが止まらなかった。

## 原因
`src/main/sessionDetect.js` の初期実装が「プロセスの存在」だけで稼働判定していた。
そのため次のものまで「動いている」と誤検出していた:

- `codex mcp-server` … Codex を一度も触っていなくてもバックグラウンド常駐する。
- アイドルな `claude` セッション（開いているだけ／LimitPeek を起動した待機中の自分自身）。

実測（`ps -axo pid=,%cpu=,comm=,args=`）:
- 稼働中 claude: `%cpu=13.4`
- アイドル claude: `%cpu=0.2`
- codex mcp-server: `%cpu=0.0`

## 修正
`src/main/sessionDetect.js` を「存在」判定から「実際に稼働中」判定へ変更:

1. `ps` の取得列に `%cpu` を追加（`pid=,%cpu=,comm=,args=`）。
2. CPU 使用率が閾値 `CPU_THRESHOLD = 4`(%) 未満のプロセスは「動いていない」として除外。
   - ps の %cpu は起動からの累積平均。アイドルは 0〜0.5%、処理中は数〜十数% に上がるため
     この値で両者を分けられる。
3. `codex` の常駐 MCP サーバー（args に `mcp-server` を含む）は対話セッションでは
   ないため、CPU に関わらず除外（`isCodexMcpServer()`）。

結果: 実際に推論・処理しているときだけ、該当プロバイダのロゴがパルスするようになった。

検証: 実プロセスで `{claude:true, codex:false}`（稼働 claude あり／codex は mcp 常駐のみ）を確認。
合成入力でアイドル除外・mcp 除外・デスクトップ Claude.app 除外も確認済み。
