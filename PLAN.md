# LimitPeek — レートリミット監視メニューバーアプリ 実装プラン

> アプリ名: **LimitPeek**（メニューバーからリミットをちらっと覗く）

## ゴール
macOS のメニューバーに常駐し、**Claude Code** と **Codex** の 5h / 7d レートリミット使用率を **% 表示**する SwiftUI ネイティブアプリ。更新間隔は設定画面で調整可能。

## 取得方法（実機検証で確定済み ✅）

### Claude Code
- 認証: `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
- リクエスト: `GET https://api.anthropic.com/api/oauth/usage`
  - `Authorization: Bearer <accessToken>`
  - `anthropic-beta: oauth-2025-04-20`
  - `Content-Type: application/json`
- レスポンスから 5h / 7day の使用率(%)とリセット時刻を取得
- ※ access_token は期限切れ時 refresh_token で更新が必要（credentials.json に expiresAt / refreshToken あり）
- ※ `/api/oauth/usage` は 429 を返しやすい既知問題あり → ポーリングは控えめに（最小間隔 1分）

### Codex
- `codex app-server`（JSON-RPC over stdio）を起動
- `initialize` → `account/rateLimits/read` を送信
- レスポンス（検証済みの実データ）:
  ```json
  "rateLimits": {
    "primary":   {"usedPercent": 2, "windowDurationMins": 300,   "resetsAt": 1782326975},  // 5h
    "secondary": {"usedPercent": 1, "windowDurationMins": 10080, "resetsAt": 1782692837}   // 7d
  }
  ```
- `usedPercent` = 使用率、`windowDurationMins`(300=5h / 10080=7d)、`resetsAt` = Unix秒
- codex バイナリのパス: `/opt/homebrew/bin/codex`（環境差異に備え `which codex` も試す）

## アプリ構成（Swift / SwiftUI, macOS）

### プロジェクト形態
- Xcode プロジェクト（`.app` 化・ログイン項目登録・配布しやすい）
- 最小ターゲット macOS 14+、`MenuBarExtra` 使用（SwiftUI 標準のメニューバー API）
- Dock アイコン非表示（`LSUIElement = true`）

### ファイル構成（案）
```
RateLimitMonitor/
├── RateLimitMonitor.xcodeproj
├── RateLimitMonitorApp.swift      # @main, MenuBarExtra でメニューバー常駐
├── Models/
│   └── RateLimit.swift            # UsageWindow(used%, resetsAt, label) 等の共通モデル
├── Providers/
│   ├── ClaudeProvider.swift       # credentials読込 + /api/oauth/usage 呼び出し
│   └── CodexProvider.swift        # app-server を Process で起動し JSON-RPC
├── ViewModel/
│   ├── UsageStore.swift           # ObservableObject, 定期ポーリング, 状態保持
│   └── Settings.swift             # UserDefaults ラッパ（間隔・トグル類）
├── Views/
│   ├── MenuBarLabel.swift         # メニューバーに出す簡易表示（例: "C 12% · X 2%"）
│   ├── MenuContentView.swift      # クリックで開くポップオーバー（バー+リセット時刻+更新ボタン）
│   └── SettingsView.swift         # 設定画面
└── Info.plist                     # LSUIElement=true
```

### メニューバー表示
- ラベル: コンパクトに `C 12%  X 2%`（Claude / Codex の 5h窓 もしくは高い方）
- クリックで開くメニュー:
  - **Claude Code**: 5h ▓▓░░ 12%（リセット 14:30）/ 7d ▓░░░ 5%（リセット 6/30）
  - **Codex**: 5h ▓░░░ 2%（…）/ 7d ▓░░░ 1%（…）
  - 区切り線 → 「今すぐ更新」「設定…」「終了」

### 設定画面（SettingsView）
- **更新間隔**: スライダー or ステッパー、範囲 **1〜30 分**（既定 5 分）
  - `UserDefaults` に保存 → 再起動後も維持
  - 変更したら即座にポーリングタイマーへ反映（`UsageStore` がタイマーを張り直す）
- **監視対象トグル**: Claude Code / Codex を個別に ON/OFF
- **自動起動**: ログイン項目に登録（`SMAppService`）のトグル

### ポーリング
- 既定 5 分間隔（設定で 1〜30 分）。最小 1 分は Claude API の 429 対策
- 手動更新ボタンあり

### エラー処理
- credentials.json 不在 / トークン期限切れ → 「未ログイン」「要再ログイン」表示
- API 429 / ネットワークエラー → 直近の取得値を保持しつつ「取得失敗（前回値）」を控えめに表示

## 実装ステップ
1. Xcode プロジェクト雛形作成（MenuBarExtra, LSUIElement, macOS 14+）
2. 共通モデル `RateLimit.swift` 定義
3. `ClaudeProvider` 実装 → 単体で取得確認
4. `CodexProvider` 実装（Process で app-server, JSON-RPC ハンドシェイク）→ 単体で取得確認
5. `Settings.swift` + `UsageStore`（ポーリング + 状態、間隔反映）
6. メニューバー UI（ラベル + メニュー）
7. 設定画面（間隔・トグル・自動起動）
8. ビルド & 起動確認、表示の検証
9. （任意）配布用の説明

## 成果物の置き場所
- プロジェクト本体: `/Users/noranekobi/coding/media/LimitPeek/`（実装は Electron。本 PLAN は当初の SwiftUI 案）
- ※ output/ は生成物（画像・動画・3D）用なのでアプリのソースはそこには置かない
