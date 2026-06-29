# Claude の使用率がリセット直後に 100% に化けるバグ

## 問題
Claude Code の 5h 窓が、レートリミットのリセット直後に 100%（満タン）と表示される。
ユーザー報告:「リセットされたら 5h トークン数が 100% になっている」。
リセット時刻の計算が間違っているように見えたが、実際は使用率の値が化けていた。

## 原因
`src/providers/claude.js` の `toPercent()` に、API が使用率を 0..1 の「比率」で
返す場合があるという古い想定が残っていた:

```js
return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
```

実 API（GET /api/oauth/usage）は `utilization` を **常に 0..100 のパーセント**で返す
（確認: utilization=2 → 2% 使用 / utilization=37 → 37% 使用）。
そのため `n <= 1` の分岐に入る低使用率が 100 倍されてしまう:

- utilization=1（=1% 使用）→ 100% ❌
- utilization=0.5（=0.5% 使用）→ 50% ❌
- utilization=0（リセット直後）→ 0%（偶然 OK）

リセット後に少しでも使うと `utilization` が 1 以下になり、満タン表示に化けていた。
リセット時刻（resets_at, UTC→ローカル変換）の計算自体は正しかった。

## 修正
`src/providers/claude.js` の `toPercent()` から比率→% の 100 倍変換を削除し、
0..100 のパーセントをそのまま小数第1位に丸めるだけにした。

```js
function toPercent(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}
```

## 検証
`node scripts/probe-claude.js` → 5h:2% / 7d:37%（実値どおり）。
境界テスト: utilization=0/0.5/1/1.5/2/37/100 → 0/0.5/1/1.5/2/37/100% で 100 倍化けが解消。
