# 2026-06-25 .app 版で Codex が表示されない

## 問題
`npm start`（開発実行）では Claude / Codex 両方メニューバーに出るのに、
`electron-builder` でビルドした `LimitPeek.app` を Finder から起動すると
**Codex だけ表示されない**（Claude は出る）。

## 原因
- `.app` を Finder / `open` から起動すると、プロセスの `PATH` が
  `/usr/bin:/bin:/usr/sbin:/sbin` 程度の最小構成になり、`/opt/homebrew/bin` が含まれない。
- `codex` CLI（`/opt/homebrew/bin/codex`）は実体がバイナリではなく
  **`#!/usr/bin/env node` のスクリプトラッパー**。実行に `node` が PATH 上に必要。
- 最小 PATH には `node`（`/opt/homebrew/bin/node`）が無いため、
  `codex app-server` 起動が `env: node: No such file or directory` で即死。
  → `CodexProvider` が timeout/spawn_error になり Codex が出なかった。
- Claude は Node 内蔵 `fetch` だけで完結するため影響を受けなかった。

## 修正
`src/providers/codex.js`:
- `spawn(codex, ['app-server'], ...)` に **`env` を明示**し、PATH に
  Homebrew / npm-global / nvm 等の共通 bin ディレクトリを先頭追加（`buildChildEnv()`）。
  これで最小 PATH 環境でも子プロセスが `node`（と `codex`）を解決できる。
- 併せて `codex` バイナリの場所を複数候補から実在チェックで解決
  （`resolveCodexBin()` / `COMMON_BIN_DIRS`）。`CODEX_BIN` 指定も実在時のみ採用。

## 検証
- 最小 PATH（`env -i HOME=$HOME PATH=/usr/bin:/bin:...`）で
  `.app` 同梱 Electron の probe-codex → Codex 取得 OK。
- 同条件で開発版を起動し、メニューバー画像に Claude・Codex 両方の % が出ることを確認。
- 修正後に再ビルドした `.app` を `open` 起動 → 常駐 OK。
