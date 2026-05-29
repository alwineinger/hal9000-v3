/**
 * spa/session.js
 * Pure helpers for creating, updating, and finalizing preheat observation sessions.
 * No I/O, no network, no LLM.
 *
 * Observation conventions:
 *  - elapsedMinutes        Total minutes since session.startedAt (non-accumulating)
 *  - observedMinutes       Same as last observation's elapsedMinutes
 *  - observedRateFPerHour  Delta-F since previous observation, annualized
 */

const { bucket, round } = require('./utils');

function buildPreheatSession({ nextSpaEvent, checkedAt, weather, currentState, leadMinutes, config = {} }) {
  if (!nextSpaEvent) return null;

  const target = config.targetTempF ?? 102;
  // Calendar events use `uid` not `id`
  const sessionId = `${nextSpaEvent.uid}:${checkedAt}`;

  return {
    sessionId,
    eventId: nextSpaEvent.uid,
    eventTitle: nextSpaEvent.title,
    eventStart: nextSpaEvent.start,
    eventEnd: nextSpaEvent.end,
    startedAt: checkedAt,
    initialSpaTempF: currentState?.spaTempF ?? null,
    ambientTempF: weather?.tempF ?? null,
    weatherDesc: weather?.desc ?? null,
    estimatedLeadMinutes: leadMinutes,
    targetTempF: target,
    observations: [
      {
        capturedAt: checkedAt,
        elapsedMinutes: 0,
        spaTempF: currentState?.spaTempF ?? null,
        observedRateFPerHour: null
      }
    ],
    status: 'active',
    completedAt: null,
    completionReason: null,
    observedMinutes: 0,
    observedRateFPerHour: null,
    startSpaBucket: bucket(currentState?.spaTempF, 2),
    ambientBucket: bucket(weather?.tempF, 5),
    lastObservedAt: checkedAt,
    lastObservedSpaTempF: currentState?.spaTempF ?? null
  };
}

function updateSessionObservation(session, { checkedAt, currentState }) {
  if (!session || session.status !== 'active') return session;

  const prevObs = session.observations && session.observations.length
    ? session.observations[session.observations.length - 1]
    : null;

  // Delta since the previous observation (for per-tick rate)
  const deltaMinutes = prevObs
    ? Math.max(0, Math.round((Date.parse(checkedAt) - Date.parse(prevObs.capturedAt)) / 60000))
    : 0;

  const deltaF = prevObs && Number.isFinite(prevObs.spaTempF) && Number.isFinite(currentState?.spaTempF)
    ? currentState.spaTempF - prevObs.spaTempF
    : 0;

  const rate = deltaMinutes > 0 ? round((deltaF / deltaMinutes) * 60, 2) : null;

  // Total elapsed since session start (non-accumulating — avoids the exponential feedback loop)
  const sessionStartMs = Date.parse(session.startedAt);
  const totalElapsedMinutes = Number.isFinite(sessionStartMs)
    ? Math.max(0, Math.round((Date.parse(checkedAt) - sessionStartMs) / 60000))
    : 0;

  const newObs = {
    capturedAt: checkedAt,
    elapsedMinutes: totalElapsedMinutes,
    spaTempF: currentState?.spaTempF ?? null,
    observedRateFPerHour: rate
  };

  const updated = {
    ...session,
    observations: [...(session.observations || []), newObs],
    lastObservedAt: checkedAt,
    lastObservedSpaTempF: currentState?.spaTempF ?? null,
    observedMinutes: totalElapsedMinutes
  };

  // Recompute overall observed rate from first to last valid observation
  const firstValid = updated.observations.find(o => Number.isFinite(o.spaTempF));
  const lastValid = [...updated.observations].reverse().find(o => Number.isFinite(o.spaTempF));
  if (firstValid && lastValid && totalElapsedMinutes >= 15) {
    const totalDelta = lastValid.spaTempF - firstValid.spaTempF;
    updated.observedRateFPerHour = round((totalDelta / totalElapsedMinutes) * 60, 2);
  }

  return updated;
}

function finalizeSession(session, reason, { checkedAt }) {
  if (!session) return null;
  return {
    ...session,
    status: 'completed',
    completedAt: checkedAt,
    completionReason: reason
  };
}

module.exports = {
  buildPreheatSession,
  updateSessionObservation,
  finalizeSession,
};
