# LimitPeek

**Claude Code** と **Codex** の 5h / 7d レートリミット使用率を macOS のメニューバーに **% 表示**する常駐アプリ（Electron 製）。

メニューバーには各サービスの公式ロゴ＋使用率がコンパクトに出る（例: `✳ 20%  ❀ 22%` ＝ Claude 20% / Codex 22%）。ロゴはテンプレート画像なのでメニューバーの明暗（ライト/ダーク）に自動追従する。表示する窓は **5h / 7d / 両方併記**（例: `✳ 20% / 5%`）から選べる。クリックすると 5h・7d のバーとリセット時刻が見られる。UI は日本語 / 英語を切り替え可能。

## 必要なもの

- macOS 12+（メニューバー常駐）
- Node.js（`npm` が使えること）
- Claude Code にログイン済み（認証情報は `~/.claude/.credentials.json` か macOS Keychain のどちらでも可）
- `codex` CLI がインストール済み（既定パス `/opt/homebrew/bin/codex`。違う場合は環境変数 `CODEX_BIN` で指定）

## 使い方

```bash
npm install      # 初回のみ
npm start        # 起動（メニューバーに常駐。Dock には出ない）
```

メニューバーのアイコンをクリック → ポップアップ。使用率のバーと設定パネルが 1 つの画面に常時並ぶ（別ウィンドウは開かない）。

操作ボタン:

- **今すぐ更新** … その場で再取得
- **終了** … アプリ終了

設定（その場で反映・自動保存され、再起動後も維持）:

- **更新間隔** … 1〜30 分（既定 5 分。最小 1 分は Claude API の 429 対策）
- **Claude Code を監視 / Codex を監視** … サービスごとに ON/OFF
- **ログイン時に自動起動** … ログイン項目に登録
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
│   └── usageStore.js  # 定期ポーリング・状態保持・429 バックオフ
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
- 配布用ビルドは `npm run dist`（未署名。手元利用向け）
