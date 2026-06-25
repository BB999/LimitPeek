'use strict';

// Claude の取得を Electron 無しで検証する。
// 秘密情報（トークン）は一切出力しない。使用率%と正規化結果のみ表示。

const { fetchClaudeUsage } = require('../src/providers/claude');

(async () => {
  const r = await fetchClaudeUsage();
  if (!r.ok) {
    console.log('NG:', r.reason, r.detail || r.retryAfterSec || '');
    if (r.raw) console.log('raw shape keys:', Object.keys(r.raw));
    process.exit(1);
  }
  const fmt = (w) =>
    w ? `${w.usedPercent}% (reset ${w.resetMs ? new Date(w.resetMs).toLocaleString() : '-'})` : 'n/a';
  console.log('OK');
  console.log('  5h :', fmt(r.fiveHour));
  console.log('  7d :', fmt(r.sevenDay));
})();
