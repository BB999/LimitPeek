# LimitPeek

**Claude Code** と **Codex** の 5h / 7d レートリミット使用率を macOS のメニューバーに **% 表示**する常駐アプリ（Electron 製）。

メニューバーには各サービスの公式ロゴ＋使用率がコンパクトに出る（例: `✳ 20%  ❀ 22%` ＝ Claude 20% / Codex 22%）。ロゴはテンプレート画像なのでメニューバーの明暗（ライト/ダーク）に自動追従する。表示する窓は **5h / 7d / 両方併記**（例: `✳ 20% / 5%`）から選べる。クリックすると 5h・7d のバーとリセット時刻が見られる。UI は日本語 / 英語を切り替え可能。

## ダウンロードして使う（推奨）

ビルド済みアプリは [Releases](https://github.com/BB999/LimitPeek/releases/latest) から入手できる（Apple Silicon / arm64 向け）。

1. 最新リリースの **`LimitPeek-x.y.z-arm64-mac.zip`** をダウンロードして解凍する
2. `LimitPeek.app` を `アプリケーション`（`/Applications`）フォルダに移動する
3. **初回だけ**ひと手間いる（このアプリは未署名のため）:
   - `LimitPeek.app` を **右クリック →「開く」**、出てくる確認ダイアログでもう一度 **「開く」**
   - これでこの先はダブルクリックで普通に起動できる

> **「"LimitPeek" は壊れているため開けません」「開発元を確認できないため開けません」と出る場合**
> ブラウザのダウンロードで付く検疫属性（quarantine）が原因。次のどちらかで回避できる。
>
> **方法 A: システム設定から許可する（ターミナル不要・おすすめ）**
> 1. 一度ダブルクリックでアプリを起動しようとする（ブロックされてOK）
> 2. **アップルメニュー  → システム設定 → プライバシーとセキュリティ** を開く
> 3. 下のほうにある **「"LimitPeek" は…ブロックされました」** の横の **「このまま開く」** をクリック
>    （macOS Sequoia 以前は「とにかく開く」）
> 4. 認証（Touch ID かパスワード）すると起動できる。次回からは普通に開ける
>
> **方法 B: ターミナルで検疫属性を外す**
> ```bash
> xattr -dr com.apple.quarantine /Applications/LimitPeek.app
> ```
> 実行後、もう一度アプリを開く。

起動するとメニューバーに使用率が出る（Dock には出ない）。あとは下の [使い方](#使い方) と同じ。

## 必要なもの

- macOS 12+ / Apple Silicon（メニューバー常駐）
- Claude Code にログイン済み（認証情報は `~/.claude/.credentials.json` か macOS Keychain のどちらでも可）
- `codex` CLI がインストール済み（既定パス `/opt/homebrew/bin/codex`。違う場合は環境変数 `CODEX_BIN` で指定）
- ※ ソースから動かす場合のみ Node.js（`npm`）も必要

## ソースから動かす（開発者向け）

```bash
npm install      # 初回のみ
npm start        # 起動（メニューバーに常駐。Dock には出ない）
```

## 使い方

メニューバーのアイコンをクリック → ポップアップ。使用率のバーと設定パネルが 1 つの画面に常時並ぶ（別ウィンドウは開かない）。

操作ボタン:

- **使用率を更新** … 使用率をその場で再取得
- **アプリをアップデート** … アプリ本体の新しいバージョンを GitHub Releases から確認。新版があればボタンが「v… にアップデート」に変わり、押すとダウンロード → 差し替え → 自動再起動まで行う（コード署名・課金不要。パッケージ版でのみ動作）。起動時にも自動でチェックする
- **終了** … アプリ終了

設定（その場で反映・自動保存され、再起動後も維持）:

- **更新間隔** … 1〜30 分（既定 5 分。最小 1 分は Claude API の 429 対策）
- **Claude Code を監視 / Codex を監視** … サービスごとに ON/OFF
- **ログイン時に自動起動** … ログイン項目に登録
- **稼働中アニメーション** … Claude / Codex のセッションが実際に動いている間、そのロゴがふわっと拡縮（パルス）する（既定 ON）。CPU 使用率で稼働を判定するため、開いているだけのアイドルや常駐 MCP サーバーでは反応しない
- **メニューバー表示** … `5h` / `7d` / `両方`（両方は `20% / 5%` のように 5h%・7d% を併記）
- **言語** … 日本語 / English

### 取得だけ単体で確認したいとき

```bash
npm run probe:claude   # Claude の使用率だけ取得して表示
npm run probe:codex    # Codex の使用率だけ取得して表示
```

## 仕組み

### Claude Code
- 認証: `~/.claude/.credentials.json` → 無ければ macOS Keychain（サービス名 `Claude Code-credentials`）から `accessToken` を取得
- `GET https://api.anthropic.com/api/oauth/usage`
  - `Authorization: Bearer <token>`
  - `anthropic-beta: oauth-2025-04-20`（無いと 401）
  - `User-Agent: claude-code/...`（**無いと即 429**。これが肝）
- このエンドポイントはポーリングに弱く 429 を返しやすい。最小 1 分間隔＋指数バックオフ＋前回値キャッシュで対策している

### Codex
- `codex app-server` を子プロセス起動し、stdio 越しに JSON-RPC（改行区切り JSON）で会話
- ハンドシェイク: `initialize` → `initialized` → `account/rateLimits/read`
- レスポンスの `rateLimits.primary`(5h) / `.secondary`(7d) から `usedPercent` を取得
- `account/rateLimits/read` は experimental 扱い。codex のバージョン更新で形が変わる可能性あり

## 構成

```
src/
├── main/
│   ├── main.js        # @main 相当。Tray 常駐・ウィンドウ・IPC
│   ├── preload.js     # contextBridge で renderer に API 公開
│   ├── store.js       # 設定の永続化（userData/settings.json）
│   ├── usageStore.js  # 定期ポーリング・状態保持・429 バックオフ
│   └── sessionDetect.js # ps で claude/codex の稼働を検出（CPU 使用率・MCP 除外）
├── providers/
│   ├── claude.js      # Keychain/ファイル読込 + /api/oauth/usage
│   └── codex.js       # app-server を spawn し JSON-RPC
└── renderer/
    ├── popup.html/.js     # メニューバークリックで開くポップアップ（設定パネルも内包）
    └── trayicon.html/.js  # メニューバー画像（ロゴ＋%）を Canvas で合成
assets/
├── claude.svg         # Claude シンボル（CC0 / Wikimedia Commons）
└── codex.svg          # OpenAI シンボル（Codex 用）
scripts/
├── probe-claude.js    # Claude 取得の単体検証（秘密値は出さない）
└── probe-codex.js     # Codex 取得の単体検証
```

## 注意

- 認証トークンは表示・ログ出力しない。Keychain/ファイルから読んで API 呼び出しに使うだけ
- Claude のトークン期限切れ時は「要再ログイン」と表示（自動リフレッシュは未対応）
- 配布用ビルド（未署名。手元利用向け）の手順:

  ```bash
  npm run dist                                          # dist/mac-arm64/LimitPeek.app を生成
  codesign --force --deep --sign - dist/mac-arm64/LimitPeek.app   # ★ad-hoc 署名（無いと「壊れている」になる）
  codesign --verify --deep --strict dist/mac-arm64/LimitPeek.app  # エラーが出ないことを確認
  ditto -c -k --keepParent dist/mac-arm64/LimitPeek.app dist/mac-arm64/LimitPeek-x.y.z-mac-arm64.zip
  ```

  `identity: null` だと electron-builder は署名をスキップし、バンドルと整合しない署名が残って Apple Silicon で「壊れている」と判定される。ビルド後に必ず `codesign` し直すこと。
