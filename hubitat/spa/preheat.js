/**
 * spa/preheat.js
 * Pure preheat lead-time calculation, historical rate blending, and override logic.
 * No I/O, no network, no LLM.
 */

const { bucket } = require('./utils');

const TARGET_TEMP_F = 102; // default; callers should pass config value when available
const BASE_HEAT_RATE_FPH = 4;
const MIN_HEAT_RATE_FPH = 1.5;
const PREHEAT_BUFFER_MIN = 15;

function sessionScore(session, current) {
  if (!session || !current) return 0;
  const spaBucketDistance = Math.abs((session.startSpaBucket ?? 0) - (current.startSpaBucket ?? 0));
  const ambientBucketDistance = Math.abs((session.ambientBucket ?? 0) - (current.ambientBucket ?? 0));
  const weatherMatch = session.weatherDesc && current.weatherDesc
    ? String(session.weatherDesc).toLowerCase() === String(current.weatherDesc).toLowerCase()
    : false;
  const elapsedBonus = Math.min(1, Math.max(0, (session.observedMinutes || 0) / 45));

  let score = 1;
  score *= 1 / (1 + (spaBucketDistance / 2));
  score *= 1 / (1 + (ambientBucketDistance / 5));
  score *= weatherMatch ? 1 : 0.85;
  score *= 0.8 + (0.2 * elapsedBonus);
  return score;
}

function calculateHistoricalRate(history, current) {
  const sessions = Array.isArray(history?.sessions) ? history.sessions : [];
  const candidates = sessions
    .filter((session) => Number.isFinite(session.observedRateFPerHour) && session.observedMinutes >= 15)
    .map((session) => ({
      session,
      score: sessionScore(session, current)
    }))
    .filter(({ score }) => score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (!candidates.length) return null;

  const weighted = candidates.reduce((acc, { session, score }) => {
    acc.weight += score;
    acc.rate += session.observedRateFPerHour * score;
    return acc;
  }, { weight: 0, rate: 0 });

  if (weighted.weight <= 0) return null;
  return weighted.rate / weighted.weight;
}

function calculateLeadMinutes({ spaTempF, ambientF, weatherDesc, history, config = {} }) {
  if (!Number.isFinite(spaTempF)) return null;
  const target = config.targetTempF ?? TARGET_TEMP_F;
  const baseRate = config.baseHeatRateFph ?? BASE_HEAT_RATE_FPH;
  const minRate = config.minHeatRateFph ?? MIN_HEAT_RATE_FPH;
  const buffer = config.preheatBufferMin ?? PREHEAT_BUFFER_MIN;

  const gap = Math.max(0, target - spaTempF);
  if (gap === 0) return 0;

  const weather = {
    tempF: ambientF,
    desc: weatherDesc
  };

  // weather penalty from weather.js is applied by caller; here we just compute base
  const base = Math.max(minRate, baseRate);
  const historicalRate = calculateHistoricalRate(history, {
    startSpaBucket: bucket(spaTempF, 2),
    ambientBucket: bucket(ambientF, 5),
    weatherDesc
  });

  const effectiveRate = historicalRate != null ? historicalRate : base;
  const minutes = Math.ceil((gap / effectiveRate) * 60) + buffer;
  return Math.max(0, minutes);
}

function resolvePreheatWindow({ nextSpaEvent, leadMinutes, override, maxOverrideLeadHours = 12 }) {
  if (!nextSpaEvent || !nextSpaEvent.start) {
    return { preheatStartMs: null, overrideApplied: false, overrideIgnored: false };
  }

  const eventStartMs = Date.parse(nextSpaEvent.start);
  if (!Number.isFinite(eventStartMs)) {
    return { preheatStartMs: null, overrideApplied: false, overrideIgnored: false };
  }

  const overrideStartMs = override && override.startAt ? Date.parse(override.startAt) : null;
  const maxLeadMs = maxOverrideLeadHours * 60 * 60 * 1000;

  if (Number.isFinite(overrideStartMs) && overrideStartMs > Date.now()) {
    const leadMs = eventStartMs - overrideStartMs;
    if (leadMs > 0 && leadMs <= maxLeadMs) {
      return {
        preheatStartMs: overrideStartMs,
        overrideApplied: true,
        overrideIgnored: false
      };
    }
    return {
      preheatStartMs: eventStartMs - (leadMinutes * 60 * 1000),
      overrideApplied: false,
      overrideIgnored: true
    };
  }

  const leadMs = (leadMinutes ?? 0) * 60 * 1000;
  return {
    preheatStartMs: eventStartMs - leadMs,
    overrideApplied: false,
    overrideIgnored: false
  };
}

module.exports = {
  sessionScore,
  calculateHistoricalRate,
  calculateLeadMinutes,
  resolvePreheatWindow,
};
