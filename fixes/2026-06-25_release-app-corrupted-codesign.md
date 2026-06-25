# リリースの .app が「壊れている」と表示され起動できない

## 問題
GitHub リリース（v0.1.0）からダウンロードした `LimitPeek.app` を起動すると、
macOS（Apple Silicon）で「"LimitPeek" は壊れているため、開けません。ゴミ箱に
入れるべきです」と表示され起動できなかった。

## 原因
2つの要因が重なっていた。

1. **署名の不整合（本質的な原因）**
   `package.json` の `build.mac.identity` が `null` で、electron-builder は
   コード署名を完全にスキップしていた（ログ: `skipped macOS code signing
   reason=identity explicitly is set to null`）。
   その結果、`.app` に残るのは Electron バイナリ素の linker-signed 署名だけで、
   バンドル全体とは整合しない状態になっていた。検証すると:
   - `codesign --verify --deep --strict` → `code has no resources but
     signature indicates they must be present`
   - `codesign -dvvv` → `Sealed Resources=none` / `Info.plist=not bound`
   Apple Silicon ではこの不整合があると「壊れている」と判定され起動を拒否する。
   quarantine 属性を外すだけでは直らない（署名自体が壊れているため）。

2. **quarantine 属性（副次的）**
   ブラウザでダウンロードした zip には `com.apple.quarantine` が付き、
   Gatekeeper のブロック対象になる。ただし今回の主因は 1 の署名不整合。

## 修正
- `package.json` の `build.mac` を変更（main.js 相当は package.json:18-26）:
  - `"target": "dir"` → `"target": "zip"`
  - `"gatekeeperAssess": false` を追加
- **ビルド後に `.app` 全体を ad-hoc 署名し直した**（これが決め手）:
  ```bash
  codesign --force --deep --sign - dist/mac-arm64/LimitPeek.app
  ```
  これで `Sealed Resources version=2 rules=13 files=11` となり、
  `codesign --verify --deep --strict` がエラーなく通るようになった。
- 署名済み `.app` を `ditto -c -k --keepParent` で zip 化し、
  解凍後も署名が保持されることを確認した上で、
  `gh release upload v0.1.0 ... --clobber` でリリースの zip を差し替えた。

## 今後ビルドするときの手順（再発防止）
```bash
npm run dist
codesign --force --deep --sign - dist/mac-arm64/LimitPeek.app   # ★必須
codesign --verify --deep --strict dist/mac-arm64/LimitPeek.app  # エラーが出ないこと
ditto -c -k --keepParent dist/mac-arm64/LimitPeek.app dist/mac-arm64/LimitPeek-<ver>-mac-arm64.zip
```
ユーザー側はダウンロード後、初回のみ右クリック →「開く」で起動する
（または `xattr -dr com.apple.quarantine LimitPeek.app`）。
