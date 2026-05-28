/**
 * spa/test-smoke.js
 * Quick sanity checks for the pure modules. Run with: node spa/test-smoke.js
 */

const assert = require('assert');
const { weatherPenalty, isWeatherRisky } = require('./weather');
const { calculateLeadMinutes, resolvePreheatWindow } = require('./preheat');
const { buildPreheatSession, updateSessionObservation } = require('./session');
const { createPendingApproval, approvalMatchesContext } = require('./approval');

console.log('Running smoke tests...');

// weather
assert.strictEqual(typeof weatherPenalty({}), 'number');
assert.strictEqual(isWeatherRisky(null), false);
assert.strictEqual(isWeatherRisky({ desc: 'Rain' }), true);

// preheat
const lead = calculateLeadMinutes({ spaTempF: 90, ambientF: 80, history: { sessions: [] } });
assert.ok(lead === null || typeof lead === 'number');

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

console.log('All smoke tests passed.');
