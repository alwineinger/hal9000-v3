/**
 * spa/test-smoke.js
 * Quick sanity checks for the pure modules. Run with: node spa/test-smoke.js
 */

const assert = require('assert');
const { weatherPenalty, isWeatherRisky } = require('./weather');
const { calculateLeadMinutes, resolvePreheatWindow } = require('./preheat');
const { buildPreheatSession, updateSessionObservation } = require('./session');
const { createPendingApproval, approvalMatchesContext } = require('./approval');
const { expireApprovalDefaultYes } = require('./approval-poll');
const { loadConfig } = require('./config');

console.log('Running smoke tests...');

// weather
assert.strictEqual(typeof weatherPenalty({}), 'number');
assert.strictEqual(isWeatherRisky(null), false);
assert.strictEqual(isWeatherRisky({ desc: 'Rain', precipMm: 2.54 }), true);
assert.strictEqual(isWeatherRisky({
  desc: 'Clear',
  precipMm: 0,
  forecast: [{
    date: '2099-01-01',
    hourly: [{ atMs: Date.now() + (60 * 60 * 1000), desc: 'Thunderstorm', chanceofrain: '10', chanceofthunder: '60' }]
  }]
}), true);
const legacyRiskAt = new Date(Date.now() + (2 * 60 * 60 * 1000));
const legacyRiskDate = [
  legacyRiskAt.getFullYear(),
  String(legacyRiskAt.getMonth() + 1).padStart(2, '0'),
  String(legacyRiskAt.getDate()).padStart(2, '0')
].join('-');
assert.strictEqual(isWeatherRisky({
  desc: 'Clear',
  precipMm: 0,
  forecast: [{
    date: legacyRiskDate,
    hourly: [{
      time: `${String(legacyRiskAt.getHours()).padStart(2, '0')}00`,
      desc: 'Rain showers',
      chanceofrain: '60',
      chanceofthunder: '0'
    }]
  }]
}), true);

// preheat
const lead = calculateLeadMinutes({ spaTempF: 90, ambientF: 80, history: { sessions: [] } });
assert.ok(lead === null || typeof lead === 'number');
const neutralLead = calculateLeadMinutes({
  spaTempF: 90,
  ambientF: 80,
  weatherDesc: 'Clear',
  history: { sessions: [] },
  config: { baseHeatRateFph: 20, minHeatRateFph: 1, preheatBufferMin: 0 }
});
const coolRainLead = calculateLeadMinutes({
  spaTempF: 90,
  ambientF: 70,
  weatherDesc: 'Rain showers',
  history: { sessions: [] },
  config: { baseHeatRateFph: 20, minHeatRateFph: 1, preheatBufferMin: 0 }
});
assert.ok(coolRainLead >= neutralLead);

// resolve window
const win = resolvePreheatWindow({ nextSpaEvent: { start: '2026-05-25T20:00:00-04:00' }, leadMinutes: 30 });
assert.ok(Number.isFinite(win.preheatStartMs));

// session
const sess = buildPreheatSession({
  nextSpaEvent: { id: 'evt1', start: '2026-05-25T20:00:00-04:00' },
  checkedAt: new Date().toISOString(),
  weather: { tempF: 85, desc: 'Sunny' },
  currentState: { spaTempF: 88 },
  leadMinutes: 40
});
assert.ok(sess && sess.sessionId);

// approval
const appr = createPendingApproval({
  nextSpaEvent: { id: 'evt1', start: '2026-05-25T20:00:00-04:00' },
  preheatStartMs: Date.now() + 10 * 60 * 1000,
  weather: { desc: 'Rain' }
});
assert.ok(appr && appr.status === 'pending');
const expiredApproval = {
  ...appr,
  expiresAt: '2026-06-03T11:59:00.000Z',
  promptSentAt: '2026-06-03T11:45:00.000Z',
  nextSpaEvent: { id: 'evt2', start: '2026-06-03T20:00:00-04:00' },
  eventContext: { source: 'calendar', summary: 'Spa time' },
  weather: { desc: 'Thunderstorm', precipMm: 4 }
};
const expiredAtMs = Date.parse('2026-06-03T12:00:00.000Z');
const expiredDefaultYes = expireApprovalDefaultYes(expiredApproval, expiredAtMs);
assert.strictEqual(expiredDefaultYes.status, 'approved');
assert.strictEqual(expiredDefaultYes.decisionSource, 'expired-default-yes');
assert.strictEqual(expiredDefaultYes.decisionAt, '2026-06-03T12:00:00.000Z');
assert.deepStrictEqual(expiredDefaultYes.nextSpaEvent, expiredApproval.nextSpaEvent);
assert.deepStrictEqual(expiredDefaultYes.eventContext, expiredApproval.eventContext);
assert.deepStrictEqual(expiredDefaultYes.weather, expiredApproval.weather);

// config
assert.strictEqual(loadConfig({}).weatherCheckLeadMin, 30);
assert.strictEqual(loadConfig({ SPA_WEATHER_CHECK_LEAD_MIN: '45' }).weatherCheckLeadMin, 45);

console.log('All smoke tests passed.');
