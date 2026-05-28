/**
 * spa/approval.js
 * Pure weather approval state machine and helpers.
 * No I/O, no network, no LLM.
 */

const { buildWeatherApprovalPrompt } = require('./weather');

function approvalMatchesContext(approval, nextSpaEvent, preheatStartMs) {
  if (!approval || !nextSpaEvent || !Number.isFinite(preheatStartMs)) return false;
  return approval.eventId === nextSpaEvent.id && approval.preheatStart === new Date(preheatStartMs).toISOString();
}

function approvalExpiresMs(approval) {
  const parsed = Date.parse(approval?.expiresAt || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function approvalPromptSent(approval) {
  return Number.isFinite(Date.parse(approval?.promptSentAt || ''));
}

function createPendingApproval({ nextSpaEvent, preheatStartMs, weather, reason }) {
  if (!nextSpaEvent || !Number.isFinite(preheatStartMs)) return null;

  return {
    eventId: nextSpaEvent.id,
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

function decideApproval(approval, decision, source, nowMs) {
  if (!approval || approval.status !== 'pending') return approval;
  return {
    ...approval,
    status: decision === 'yes' ? 'approved' : 'denied',
    decisionAt: new Date(nowMs).toISOString(),
    decisionSource: source || 'manual'
  };
}

/**
 * Resolve a pending approval from polling/check result.
 * Called by scheduler.js after approval-poll.js reports a user reply or timeout.
 *
 * @param {object} approval  - current approval object
 * @param {'yes'|'no'} decision - 'yes' = approved, 'no' = denied
 * @param {string} source     - 'telegram-reply' | 'expired' | 'manual'
 * @param {number} nowMs      - current timestamp ms
 */
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
  approvalPromptSent,
  createPendingApproval,
  stampApprovalPrompt,
  decideApproval,
  decideFromPollResult,
};
