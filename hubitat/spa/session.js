/**
 * spa/session.js
 * Pure helpers for creating, updating, and finalizing preheat observation sessions.
 * No I/O, no network, no LLM.
 */

const { bucket, round } = require('./utils');

function buildPreheatSession({ nextSpaEvent, checkedAt, weather, currentState, leadMinutes, config = {} }) {
  if (!nextSpaEvent) return null;

  const target = config.targetTempF ?? 102;
  const sessionId = `${nextSpaEvent.id}:${checkedAt}`;

  return {
    sessionId,
    eventId: nextSpaEvent.id,
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

  const elapsedMinutes = prevObs
    ? Math.max(0, Math.round((Date.parse(checkedAt) - Date.parse(prevObs.capturedAt)) / 60000))
    : 0;

  const deltaF = prevObs && Number.isFinite(prevObs.spaTempF) && Number.isFinite(currentState?.spaTempF)
    ? currentState.spaTempF - prevObs.spaTempF
    : 0;

  const rate = elapsedMinutes > 0 ? round((deltaF / elapsedMinutes) * 60, 2) : null;

  const newObs = {
    capturedAt: checkedAt,
    elapsedMinutes: (session.observedMinutes || 0) + elapsedMinutes,
    spaTempF: currentState?.spaTempF ?? null,
    observedRateFPerHour: rate
  };

  const updated = {
    ...session,
    observations: [...(session.observations || []), newObs],
    lastObservedAt: checkedAt,
    lastObservedSpaTempF: currentState?.spaTempF ?? null,
  };

  const totalElapsed = updated.observations.reduce((sum, o) => sum + (o.elapsedMinutes || 0), 0);
  updated.observedMinutes = totalElapsed;

  // recompute overall observed rate from first to last valid observation
  const firstValid = updated.observations.find(o => Number.isFinite(o.spaTempF));
  const lastValid = [...updated.observations].reverse().find(o => Number.isFinite(o.spaTempF));
  if (firstValid && lastValid && totalElapsed >= 15) {
    const totalDelta = lastValid.spaTempF - firstValid.spaTempF;
    updated.observedRateFPerHour = round((totalDelta / totalElapsed) * 60, 2);
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
