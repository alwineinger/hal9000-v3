/**
 * spa/weather.js
 * Pure weather risk assessment and penalty calculation.
 * No I/O, no network, no LLM.
 */

const { parseIntOrNull } = require('./utils');

function weatherPenalty(weather) {
  if (!weather) return 1;
  const desc = String(weather.desc || '').toLowerCase();
  let multiplier = 1;
  if (Number.isFinite(weather.tempF) && weather.tempF < 80) {
    multiplier *= Math.max(0.7, 1 - ((80 - weather.tempF) * 0.03));
  }
  if (/rain|storm|thunder|squall|shower/.test(desc)) {
    multiplier *= 0.9;
  }
  return Math.max(0.7, multiplier);
}

function isWeatherRisky(weather) {
  if (!weather) return false;
  const desc = String(weather.desc || '').toLowerCase();
  if (/rain|storm|thunder|squall|shower/.test(desc)) return true;
  if (Number.isFinite(weather.precipMm) && weather.precipMm > 0) return true;

  const forecasts = Array.isArray(weather.forecast) ? weather.forecast : [];
  const nowMs = Date.now();
  const horizonStartMs = nowMs - (30 * 60 * 1000);
  const horizonEndMs = nowMs + (4 * 60 * 60 * 1000);

  for (const day of forecasts) {
    const date = day?.date;
    const hours = Array.isArray(day?.hourly) ? day.hourly : [];
    for (const hour of hours) {
      if (!date) continue;
      const time = String(hour?.time || '0').padStart(4, '0');
      const hourDate = new Date(`${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00`);
      const hourMs = hourDate.getTime();
      if (!Number.isFinite(hourMs) || hourMs < horizonStartMs || hourMs > horizonEndMs) continue;
      const hourDesc = String(hour?.desc || '').toLowerCase();
      const chanceRain = parseIntOrNull(hour?.chanceofrain);
      let chanceThunder = parseIntOrNull(hour?.chanceofthunder);

      // Keyword fallback: if chanceofthunder is missing/0 and desc has storm keywords,
      // treat as thunder-risky (OpenWeather onecall may not provide native thunder prob)
      if (!Number.isFinite(chanceThunder) || chanceThunder === 0) {
        if (/storm|thunder|thunders/.test(hourDesc)) {
          chanceThunder = 50;
        }
      }

      if (/rain|storm|thunder|squall|shower/.test(hourDesc)) return true;
      if (Number.isFinite(chanceRain) && chanceRain >= 50) return true;
      if (Number.isFinite(chanceThunder) && chanceThunder >= 35) return true;
    }
  }

  return false;
}

function buildWeatherApprovalPrompt({ nextSpaEvent, preheatStartMs, weather }) {
  const fmt = (ms) => new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const startText = Number.isFinite(preheatStartMs) ? fmt(preheatStartMs) : 'the preheat window';
  const eventText = nextSpaEvent?.start ? fmt(Date.parse(nextSpaEvent.start)) : 'the Spa event';
  const desc = String(weather?.desc || 'weather').toLowerCase();
  const precip = Number.isFinite(weather?.precipMm) ? `, precip ${weather.precipMm} mm` : '';
  return `Rain/storm check for the Spa preheat at ${startText}. Current weather: ${desc}${precip}. Spa event: ${eventText}. Reply YES to continue heating, or NO to skip it. Default is YES if you do not respond.`;
}

module.exports = {
  weatherPenalty,
  isWeatherRisky,
  buildWeatherApprovalPrompt,
};
