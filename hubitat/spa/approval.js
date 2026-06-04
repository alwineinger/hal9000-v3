/**
 * spa/approval.js
 * Pure weather approval state machine and helpers.
 * No I/O, no network, no LLM.
 */

const { buildWeatherApprovalPrompt } = require('./weather');

function approvalMatchesContext(approval, nextSpaEvent, preheatStartMs) {
  // Strict UID check: an approval from event A must never match event B
  if (!approval || !nextSpaEvent || !Number.isFinite(preheatStartMs)) return false;
  if (approval.eventId !== nextSpaEvent.uid) return false;
  return approval.preheatStart === new Date(preheatStartMs).toISOString();
}

function approvalExpiresMs(approval) {
  const parsed = Date.parse(approval?.expiresAt || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function createPendingApproval({ nextSpaEvent, preheatStartMs, weather, reason }) {
  if (!nextSpaEvent || !Number.isFinite(preheatStartMs)) return null;

  return {
    eventId: nextSpaEvent.uid,
    preheatStart: new Date(preheatStartMs).toISOString(),
    status: 'pending',
    reason: reason || 'Weather conditions indicate rain or storms are present or likely.',
    promptText: buildWeatherApprovalPrompt({ nextSpaEvent, preheatStartMs, weather }),
    decisionAt: null,
    decisionSource: null,
    promptSentAt: null,
    expiresAt: null,
    promptDelivery: null,
    deliveryFailed: false
  };
}

function stampApprovalPrompt(approval, delivery, nowMs, timeoutMin = 5) {
  if (!approval) return approval;
  return {
    ...approval,
    promptSentAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + (timeoutMin * 60 * 1000)).toISOString(),
    promptDelivery: delivery,
    deliveryFailed: !delivery?.ok
  };
}

function decideFromPollResult(approval, decision, source, nowMs) {
  if (!approval || approval.status !== 'pending') return approval;
  return {
    ...approval,
    status: decision === 'yes' ? 'approved' : 'denied',
    decisionAt: new Date(nowMs).toISOString(),
    decisionSource: source || 'poll-result'
  };
}

module.exports = {
  approvalMatchesContext,
  approvalExpiresMs,
  createPendingApproval,
  stampApprovalPrompt,
  decideFromPollResult,
};
