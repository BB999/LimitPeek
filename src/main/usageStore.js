'use strict';

// 定期ポーリングと状態保持。間隔変更を即反映し、Claude の 429 はバックオフする。

const EventEmitter = require('events');
const { fetchClaudeUsage } = require('../providers/claude');
const { fetchCodexUsage } = require('../providers/codex');

class UsageStore extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.timer = null;
    this.inFlight = false;
    // 各サービスの直近の状態（取得失敗時も前回値を保持して表示する）
    this.state = {
      claude: { status: 'idle', data: null, updatedAt: null, error: null },
      codex: { status: 'idle', data: null, updatedAt: null, error: null },
    };
    // Claude 429 バックオフ管理
    this.claudeBackoffUntil = 0;
    this.claudeBackoffStep = 0;
  }

  setSettings(next) {
    const intervalChanged = next.intervalMin !== this.settings.intervalMin;
    this.settings = next;
    if (intervalChanged) this.restart();
  }

  start() {
    this.refresh(); // 起動直後に1回
    this.restart();
  }

  restart() {
    if (this.timer) clearInterval(this.timer);
    const ms = Math.max(1, this.settings.intervalMin) * 60 * 1000;
    this.timer = setInterval(() => this.refresh(), ms);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const tasks = [];
      if (this.settings.watchClaude) tasks.push(this.refreshClaude());
      if (this.settings.watchCodex) tasks.push(this.refreshCodex());
      await Promise.all(tasks);
    } finally {
      this.inFlight = false;
      this.emit('change', this.snapshot());
    }
  }

  async refreshClaude() {
    // バックオフ中はスキップ（前回値を保持）
    if (Date.now() < this.claudeBackoffUntil) return;

    const r = await fetchClaudeUsage();
    const s = this.state.claude;
    if (r.ok) {
      this.claudeBackoffStep = 0;
      s.status = 'ok';
      s.data = { fiveHour: r.fiveHour, sevenDay: r.sevenDay };
      s.updatedAt = Date.now();
      s.error = null;
    } else {
      if (r.reason === 'rate_limited') {
        // 指数バックオフ: 60s, 90s, 135s ... 上限 10分
        this.claudeBackoffStep += 1;
        const base = (r.retryAfterSec ? r.retryAfterSec * 1000 : 60000);
        const delay = Math.min(base * Math.pow(1.5, this.claudeBackoffStep - 1), 600000);
        this.claudeBackoffUntil = Date.now() + delay;
      }
      s.status = 'error';
      s.error = r.reason;
      // data は前回値のまま保持
    }
  }

  async refreshCodex() {
    const r = await fetchCodexUsage();
    const s = this.state.codex;
    if (r.ok) {
      s.status = 'ok';
      s.data = { fiveHour: r.fiveHour, sevenDay: r.sevenDay, planType: r.planType };
      s.updatedAt = Date.now();
      s.error = null;
    } else {
      s.status = 'error';
      s.error = r.reason;
    }
  }

  snapshot() {
    return {
      claude: { ...this.state.claude, enabled: this.settings.watchClaude },
      codex: { ...this.state.codex, enabled: this.settings.watchCodex },
      settings: this.settings,
    };
  }
}

module.exports = { UsageStore };
