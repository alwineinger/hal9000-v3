/**
 * spa/config.js
 * Centralized configuration and constants for the spa scheduling automation.
 * Pure module — no I/O, no side effects.
 */

const DEFAULTS = {
  TARGET_TEMP_F: 102,
  BASE_HEAT_RATE_FPH: 4,
  PREHEAT_BUFFER_MIN: 15,
  MIN_HEAT_RATE_FPH: 1.5,
  WEATHER_APPROVAL_TIMEOUT_MIN: 5,
  MAX_OVERRIDE_LEAD_HOURS: 12,
  WEATHER_LOCATION: 'Tampa, FL',
};

function loadConfig(env = process.env) {
  return {
    targetTempF: Number(env.SPA_TARGET_TEMP_F || DEFAULTS.TARGET_TEMP_F),
    baseHeatRateFph: Number(env.SPA_BASE_HEAT_RATE_FPH || DEFAULTS.BASE_HEAT_RATE_FPH),
    preheatBufferMin: Number(env.SPA_PREHEAT_BUFFER_MIN || DEFAULTS.PREHEAT_BUFFER_MIN),
    minHeatRateFph: Number(env.SPA_MIN_HEAT_RATE_FPH || DEFAULTS.MIN_HEAT_RATE_FPH),
    weatherApprovalTimeoutMin: Number(env.SPA_WEATHER_APPROVAL_TIMEOUT_MIN || DEFAULTS.WEATHER_APPROVAL_TIMEOUT_MIN),
    maxOverrideLeadHours: Number(env.SPA_MAX_OVERRIDE_LEAD_HOURS || DEFAULTS.MAX_OVERRIDE_LEAD_HOURS),
    weatherLocation: env.SPA_WEATHER_LOCATION || DEFAULTS.WEATHER_LOCATION,
    allowLlm: env.SPA_ALLOW_LLM === '1',
    weatherApprovalNotify: env.SPA_WEATHER_APPROVAL_NOTIFY === '1',
    weatherApprovalChannel: env.SPA_WEATHER_APPROVAL_CHANNEL || 'telegram',
    weatherApprovalTarget: env.SPA_WEATHER_APPROVAL_TARGET || '',
    openclawBin: env.OPENCLAW_BIN || 'openclaw',
  };
}

module.exports = {
  DEFAULTS,
  loadConfig,
};
