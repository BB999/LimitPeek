# 課金（Developer ID 署名）なしでアプリ自動更新を実装

## 背景 / 要望
メニュー画面に「更新をチェック」ボタンを置き、自動でアプリを最新版へ
更新できるようにする。Apple Developer Program（年99ドル）への課金なし、
かつ ad-hoc 署名のままで実現すること。

## 制約と判断
- `electron-updater`（Squirrel.Mac）は **Developer ID コード署名が必須**で、
  本アプリ（`build.mac.identity: null` → ad-hoc 署名）では使えない。
- そこで **GitHub Releases の zip を自前で取得 → 展開 → ad-hoc 署名し直し →
  既存 .app と差し替え → 再起動** する独自方式を採用。署名・課金とも不要で、
  既存のリリース運用（zip を GitHub に上げる）をそのまま使える。
  この「ビルド後に ad-hoc 署名し直す」手順は
  `2026-06-25_release-app-corrupted-codesign.md` の再発防止策と同じ。

## 実装
- 新規 `src/main/updater.js`:
  - `checkForUpdate()` … GitHub API `/repos/BB999/LimitPeek/releases/latest`
    から最新 tag を取得し、`app.getVersion()` と semver 比較。mac/arm64 の
    `.zip` 資産 URL を返す。
  - `downloadAndInstall(info, onProgress)` … zip を一時 DL → `ditto -x -k` で
    展開 → `codesign --force --deep --sign -` で ad-hoc 署名 →
    `codesign --verify --deep --strict` で検証 → 既存 .app を退避してから
    `ditto` で差し替え（失敗時はロールバック）→ `app.relaunch()` + `exit()`。
  - **開発実行（`!app.isPackaged`）では `dev_mode` を throw して中断**。
    誤って `node_modules/.../Electron.app` を上書きする事故を防ぐ。
- `src/main/main.js`:
  - `updateState` を保持し、`check-update` / `apply-update` /
    `get-update-state` の IPC を追加。ポップアップへ `update-state` を push。
  - 起動 4 秒後にパッケージ版のみ静かに `checkUpdate(true)`（失敗は idle）。
- `src/main/preload.js`: `getUpdateState` / `checkUpdate` / `applyUpdate` /
  `onUpdateState` を公開。
- `src/renderer/popup.html` + `popup.js`:
  - 「更新をチェック」ボタンを追加。新版があると緑の「v… に更新」へ変化し、
    押すと DL→署名→差し替え→自動再起動。進捗（ダウンロード/検証/置き換え/
    再起動）を下部に表示。ja/en 両対応。

## 検証
- `cmpVer` / `parseVer` の単体テスト（0.3.10>0.3.2 等）OK。
- 実際の GitHub API で `checkForUpdate()` を実行。現在=最新(0.3.2) →
  `available:false`、現在=0.3.1 → `available:true` を確認。
- 資産名 `LimitPeek-<ver>-arm64-mac.zip` が検出ロジックにマッチすることを確認。
- `npm start` で起動エラーなし（dev 実行のため自動更新は dev_mode で停止）。

## 注意
- 実機での差し替え→再起動は **パッケージ版でのみ**動く。dev では確認不可。
- リリース zip は従来どおり ad-hoc 署名済みを上げること（更新側でも署名し直す
  ので必須ではないが、初回 DL ユーザーのためにも維持推奨）。
