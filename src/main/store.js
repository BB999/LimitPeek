'use strict';

// 依存を増やさない最小の設定永続化。userData 配下に settings.json を置く。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  intervalMin: 5, // ポーリング間隔（分）。最小 1（Claude 429 対策）
  watchClaude: true,
  watchCodex: true,
  launchAtLogin: false,
  lang: 'ja', // 表示言語 'ja' | 'en'
  trayWindow: '5h', // メニューバーに出す窓 '5h' | '7d' | 'both'
  pulseOnSession: true, // セッション稼働中にロゴをパルスさせる
};

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  const merged = { ...DEFAULTS, ...settings };
  // 間隔は 1〜30 分にクランプ
  merged.intervalMin = Math.min(30, Math.max(1, Number(merged.intervalMin) || 5));
  // 言語は ja / en のみ許容
  merged.lang = merged.lang === 'en' ? 'en' : 'ja';
  // メニューバー表示窓は 5h / 7d / both のみ許容
  merged.trayWindow = ['7d', 'both'].includes(merged.trayWindow) ? merged.trayWindow : '5h';
  // パルス設定は真偽値に正規化
  merged.pulseOnSession = !!merged.pulseOnSession;
  try {
    fs.writeFileSync(filePath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch {
    /* 失敗してもアプリは続行 */
  }
  return merged;
}

module.exports = { load, save, DEFAULTS };
