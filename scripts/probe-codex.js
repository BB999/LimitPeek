'use strict';

// Codex の取得を検証する。使用率%と構造のみ表示。

const { fetchCodexUsage } = require('../src/providers/codex');

(async () => {
  const r = await fetchCodexUsage();
  if (!r.ok) {
    console.log('NG:', r.reason, r.detail || '');
    if (r.raw) console.log('raw:', JSON.stringify(r.raw).slice(0, 400));
    process.exit(1);
  }
  const fmt = (w) =>
    w ? `${w.usedPercent}% (reset ${w.resetMs ? new Date(w.resetMs).toLocaleString() : '-'})` : 'n/a';
  console.log('OK  plan:', r.planType || '-');
  console.log('  5h (primary)  :', fmt(r.fiveHour));
  console.log('  7d (secondary):', fmt(r.sevenDay));
})();
