# 自動更新のセキュリティ強化（取得元の限定・パストラバーサル対策）

## 問題
コミットのセキュリティレビューで、自己更新（`src/main/updater.js`）に 4 件の
指摘が出た。

1. **配信物の完全性検証が fail-open**
   DL した zip を `codesign --force --sign -` で **ad-hoc 署名し直してから**
   `codesign --verify` していたため、改ざんされた zip でも署名し直しで検証を
   必ず通してしまう。`--verify` は真正性検証になっていなかった。
2. **ファイル名によるパストラバーサル**
   GitHub API 由来の `info.name` を `path.join(work, info.name)` にそのまま
   使用。`../` を含む名前で作業ディレクトリ外へ書き込める恐れ。
3. **無検証のリダイレクト追従**
   `httpsGetJson` / `downloadTo` が `res.headers.location` を無検証で追従。
   任意ドメイン・`http://` へ誘導されうる。
4. **ダウンロード URL のホスト未検証**
   `info.url`（`browser_download_url`）を無検証で `downloadTo` に渡していた。

## 修正（src/main/updater.js）
- **取得元を GitHub 正規ドメインの HTTPS のみに限定**する `isAllowedUrl()` を
  追加（`api.github.com` / `github.com` / `codeload.github.com` /
  `*.githubusercontent.com`）。`https:` 以外、リスト外ホスト、サフィックス偽装
  （`github.com.evil.com`）はすべて拒否。
  - `httpsGetJson` / `downloadTo` の初回 URL と**リダイレクト先**の両方を検証
    （`blocked_host` / `blocked_redirect`）。
  - `downloadAndInstall` 冒頭でも `info.url` を検証。
- **`info.name` を `path.basename()` 化**してパストラバーサルを防止。
- #1 は Developer ID 署名が無い以上ローカルでの真正性検証は不可能なため、
  **真正性は「GitHub 正規ドメインからの HTTPS 取得 + TLS」で担保する**設計で
  あることをコメントで明記（`codesign --verify` は自己整合チェックに留まる旨）。

## 検証
- `isAllowedUrl()` の単体チェック 10 ケース（正規 URL は許可、http・他ドメイン・
  サフィックス偽装・非 URL は拒否）すべて期待通り。
- 実 GitHub API で `checkForUpdate()` の正常系が壊れていないこと
  （`url=github.com/...`, `name=LimitPeek-...zip`）を確認。
- v0.3.3 で配布。
