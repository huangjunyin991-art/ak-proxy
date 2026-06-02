(function(global) {
  const QUALITY_LEVELS = [
    { id: 'ultra', label: '超清', width: 1280, height: 720, maxBitrate: 2200000, maxFramerate: 30, minScore: 0.78, upgradeScore: 0.88 },
    { id: 'high', label: '高清', width: 960, height: 540, maxBitrate: 1400000, maxFramerate: 24, minScore: 0.62, upgradeScore: 0.74 },
    { id: 'medium', label: '标清', width: 640, height: 360, maxBitrate: 800000, maxFramerate: 15, minScore: 0.42, upgradeScore: 0.58 },
    { id: 'low', label: '省流', width: 320, height: 180, maxBitrate: 300000, maxFramerate: 10, minScore: 0, upgradeScore: 0.35 }
  ];

  const QUALITY_LOOKUP = QUALITY_LEVELS.reduce((acc, level, index) => {
    acc[level.id] = Object.assign({ index }, level);
    return acc;
  }, {});

  function clamp01(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }

  function normalizeValue(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function getQualityLevelById(id) {
    return QUALITY_LOOKUP[String(id || '').trim().toLowerCase()] || QUALITY_LEVELS[1];
  }

  function getInitialQualityLevel() {
    return QUALITY_LEVELS[1];
  }

  function computeQualityScore(stats) {
    const sample = stats || {};
    const rtt = normalizeValue(sample.rtt, 0);
    const jitter = normalizeValue(sample.jitter, 0);
    const packetLoss = clamp01(sample.packetLoss || 0);
    const bitrateRatio = clamp01(sample.bitrateRatio || 0.9);
    const fpsRatio = clamp01(sample.fpsRatio || 0.9);
    const availableRatio = clamp01(sample.availableRatio || 0.9);

    const latencyScore = rtt > 0 ? Math.max(0, 1 - Math.min(rtt, 800) / 800) : 0.65;
    const jitterScore = jitter > 0 ? Math.max(0, 1 - Math.min(jitter, 120) / 120) : 0.7;
    const lossScore = Math.max(0, 1 - Math.min(packetLoss, 0.45) / 0.45);
    const throughputScore = (bitrateRatio + fpsRatio + availableRatio) / 3;

    return clamp01((latencyScore * 0.18) + (jitterScore * 0.18) + (lossScore * 0.34) + (throughputScore * 0.30));
  }

  class VideoQualityController {
    constructor(options) {
      const config = options || {};
      this.levels = Array.isArray(config.levels) && config.levels.length ? config.levels.slice() : QUALITY_LEVELS.slice();
      this.currentLevel = getQualityLevelById(config.initialLevel || 'high');
      this.cooldownMs = Math.max(5000, Number(config.cooldownMs) || 12000);
      this.upgradeCooldownMs = Math.max(this.cooldownMs * 1.5, Number(config.upgradeCooldownMs) || 18000);
      this.minSamples = Math.max(3, Number(config.minSamples) || 4);
      this.sampleLimit = Math.max(8, Number(config.sampleLimit) || 12);
      this.sampleWindow = [];
      this.lastActionAt = 0;
      this.lastUpgradeAt = 0;
      this.lastDowngradeAt = 0;
      this.frozen = false;
      this.onChange = typeof config.onChange === 'function' ? config.onChange : function() {};
      this.onDebug = typeof config.onDebug === 'function' ? config.onDebug : function() {};
    }

    getState() {
      return {
        level: this.currentLevel,
        frozen: this.frozen,
        lastActionAt: this.lastActionAt,
        sampleCount: this.sampleWindow.length
      };
    }

    freeze() {
      this.frozen = true;
    }

    unfreeze() {
      this.frozen = false;
    }

    setLevelById(levelId, reason) {
      const nextLevel = getQualityLevelById(levelId);
      if (nextLevel.id === this.currentLevel.id) return this.currentLevel;
      this.currentLevel = nextLevel;
      this.lastActionAt = Date.now();
      if (reason === 'downgrade') this.lastDowngradeAt = this.lastActionAt;
      if (reason === 'upgrade') this.lastUpgradeAt = this.lastActionAt;
      this.onChange(this.getState(), reason || 'manual');
      return this.currentLevel;
    }

    pushSample(sample) {
      if (this.frozen) return this.getState();
      const now = Date.now();
      const normalized = {
        at: now,
        score: clamp01(sample && sample.score),
        rtt: normalizeValue(sample && sample.rtt, 0),
        jitter: normalizeValue(sample && sample.jitter, 0),
        packetLoss: clamp01(sample && sample.packetLoss),
        bitrateRatio: clamp01(sample && sample.bitrateRatio),
        fpsRatio: clamp01(sample && sample.fpsRatio),
        availableRatio: clamp01(sample && sample.availableRatio),
        localConnected: !!(sample && sample.localConnected),
        remoteConnected: !!(sample && sample.remoteConnected),
        videoActive: !!(sample && sample.videoActive)
      };
      this.sampleWindow.push(normalized);
      if (this.sampleWindow.length > this.sampleLimit) this.sampleWindow.shift();
      const decision = this.evaluate(now);
      if (decision) this.onDebug(decision);
      return this.getState();
    }

    evaluate(now) {
      if (this.frozen || this.sampleWindow.length < this.minSamples) return null;
      const recent = this.sampleWindow.slice(-this.minSamples);
      const avgScore = recent.reduce((sum, item) => sum + item.score, 0) / recent.length;
      const avgLoss = recent.reduce((sum, item) => sum + item.packetLoss, 0) / recent.length;
      const avgRtt = recent.reduce((sum, item) => sum + item.rtt, 0) / recent.length;
      const avgJitter = recent.reduce((sum, item) => sum + item.jitter, 0) / recent.length;
      const currentIndex = this.currentLevel.index;
      const canDowngrade = now - this.lastDowngradeAt >= this.cooldownMs;
      const canUpgrade = now - this.lastUpgradeAt >= this.upgradeCooldownMs;
      const poorNetwork = avgScore < this.currentLevel.minScore || avgLoss > 0.12 || avgRtt > 260 || avgJitter > 45;
      const healthyNetwork = avgScore >= this.currentLevel.upgradeScore && avgLoss < 0.05 && avgRtt < 180 && avgJitter < 30;

      if (poorNetwork && canDowngrade && currentIndex < this.levels.length - 1) {
        const nextLevel = this.levels[currentIndex + 1];
        this.currentLevel = nextLevel;
        this.lastDowngradeAt = now;
        this.lastActionAt = now;
        const result = { action: 'downgrade', level: nextLevel, score: avgScore, loss: avgLoss, rtt: avgRtt, jitter: avgJitter };
        this.onChange(this.getState(), result);
        return result;
      }

      if (healthyNetwork && canUpgrade && currentIndex > 0) {
        const nextLevel = this.levels[currentIndex - 1];
        this.currentLevel = nextLevel;
        this.lastUpgradeAt = now;
        this.lastActionAt = now;
        const result = { action: 'upgrade', level: nextLevel, score: avgScore, loss: avgLoss, rtt: avgRtt, jitter: avgJitter };
        this.onChange(this.getState(), result);
        return result;
      }

      return { action: 'hold', level: this.currentLevel, score: avgScore, loss: avgLoss, rtt: avgRtt, jitter: avgJitter };
    }
  }

  const api = {
    QUALITY_LEVELS,
    QUALITY_LOOKUP,
    VideoQualityController,
    computeQualityScore,
    getInitialQualityLevel,
    getQualityLevelById
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.AKRemoteVoiceQualityModule = api;
})(typeof window !== 'undefined' ? window : globalThis);
