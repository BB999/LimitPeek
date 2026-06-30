# 自動更新の再起動時に「Object has been destroyed」でクラッシュ

## 問題
自己更新（GitHub Releases 方式）の実機テストで、ダウンロード→展開→署名→
差し替えまでは成功するのに、**再起動の瞬間にメインプロセスがクラッシュ**して
エラーダイアログが出た。

```
A JavaScript error occurred in the main process
Uncaught Exception:
TypeError: Object has been destroyed
  at requestTrayRender (src/main/main.js:170)
  at Timeout._onTimeout (src/main/main.js:63)   ← パルスループのタイマー
```

## 原因
更新適用の最後で `app.relaunch()` → `app.exit(0)` を呼んだ後も、稼働中の
`setInterval` 群（パルスアニメ・使用率ポーリング・セッション監視）が止まって
おらず、`exit` でウィンドウ／`webContents` が破棄された後にタイマーが発火し、
`requestTrayRender()` が破棄済みの `trayRenderer.webContents.send()` を呼んで
例外になっていた。

`relaunch`/`exit` を `updater.js`（差し替えを担当）の中で直接呼んでいたため、
メイン側のタイマーを片付ける隙が無かったのも一因。

## 修正
1. **再起動の責務を分離**（`src/main/updater.js`）
   - `downloadAndInstall()` は差し替え完了で `{ ok:true }` を返すだけにし、
     `app.relaunch()`/`exit()` を撤去。
   - 代わりに `relaunchApp()` を export し、呼び出し側が後始末後に呼ぶ。
2. **再起動前に全タイマーを停止＋描画を抑止**（`src/main/main.js`）
   - `isQuitting` フラグを追加。`requestTrayRender()` 冒頭で
     `if (isQuitting) return;` と `webContents.isDestroyed()` ガードを追加。
   - `shutdownForRelaunch()` を新設：`isQuitting=true` → `stopPulseLoop()` →
     `usage.stop()` → `sessionDetector.stop()`。
   - `applyUpdate()` は差し替え成功後に `shutdownForRelaunch()` →
     `updater.relaunchApp()` の順で呼ぶ。

## 検証
- 実機セルフテスト（0.3.1 → 0.3.2）で再確認:
  - download → verify → swap → 差し替え後バンドルが 0.3.2 になることを確認。
  - タイマー停止が例外なく完了（`Object has been destroyed` が出ない）。
  - `relaunchApp()` 後に新プロセスが 0.3.2 で起動。無限ループなし。
- 修正前は同条件で必ずクラッシュダイアログが出ていた。

## 追記: relaunch 以外でも起きる既存バグだった
検証後、**実運用版（/Applications の 0.3.2、自動更新も入っていない 6/29 版）**
が、自動更新と無関係に同じスタックでクラッシュする現象を確認した。

```
TypeError: Object has been destroyed
  at requestTrayRender (/Applications/LimitPeek.app/.../main.js:170)
  at Timeout._onTimeout (.../main.js:63)   ← パルスタイマー
```

つまりこれは relaunch 特有ではなく、**パルス機能に元から潜んでいた既存バグ**。
スリープ復帰・GPU プロセス再生成などで `trayRenderer.webContents` が破棄された
後にパルスタイマー(12fps)が発火すると、ガード無しの `requestTrayRender()` が
破棄済み `webContents.send()` を呼んで落ちていた。

上記の `requestTrayRender()` 冒頭ガード
（`trayRenderer.isDestroyed()` / `webContents.isDestroyed()` チェック）は
この既存クラッシュも同時に塞ぐ。v0.3.3 で配布。
