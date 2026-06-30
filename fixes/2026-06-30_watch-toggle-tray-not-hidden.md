# 監視オフがメニューバーに即反映されないバグ

## 問題
設定で「Claude を監視」「Codex を監視」をオフにしても、メニューバーから
該当ロゴ／使用率が消えなかった。トグルのロジック自体（`trayItems()` の
`pick()` が `if (!svc.enabled) return null;` で弾く）は正しいのに、
画面に反映されなかった。

## 原因
`src/main/main.js` の `save-settings` IPC ハンドラが、再描画に
`lastSnap`（直近の `usage.on('change')` で作られた古いスナップショット）を
優先して使っていた。

```js
const snap = lastSnap || (usage && usage.snapshot());
if (snap) requestTrayRender(snap);
```

`usageStore.snapshot()` は `enabled: this.settings.watchClaude` のように
**呼び出し時点の settings** を焼き込んで返す。`usage.setSettings(settings)`
で設定は更新されるが、`lastSnap` の中身（`enabled` フラグ）は再生成されない
ため、`requestTrayRender(lastSnap)` が**古い enabled=true のまま**描画して
しまい、オフにしてもロゴが残った。

## 修正
`src/main/main.js`（旧 261-262 行）。設定保存後の再描画では必ず最新の
スナップショットを作り直し、`lastSnap` も更新するように変更。

```js
const snap = usage ? usage.snapshot() : lastSnap;
if (snap) {
  lastSnap = snap;
  requestTrayRender(snap);
}
```

これで watch オフが即座にメニューバーへ反映される。
