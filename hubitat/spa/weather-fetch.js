/**
 * spa/weather-fetch.js
 * Fetches current weather + 4-hour forecast from wttr.in for the spa location.
 * Pure I/O module — no business logic.
 *
 * Output shape:
 * {
 *   tempF: number,
 *   desc: string,
 *   precipMm: number,
 *   forecast: [{
 *     date: 'YYYY-MM-DD',
 *     hourly: [{ time: 'HHMM', weatherDesc: [{value}], chanceofrain, chanceofthunder }]
 *   }]
 * }
 */

const { spawnSync } = require('child_process');

const LOCATION = 'Tampa,FL';

function fetchWeather() {
  // Use wttr.in JSON format (Tampa FL is close enough to 15901 Layton Ct for weather)
  const result = spawnSync('curl', [
    '-s',
    '--connect-timeout', '10',
    `wttr.in/${LOCATION}?format=j1`
  ], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
    env: { ...process.env, PATH: process.env.PATH + ':/Users/oc_user/Library/Python/3.9/bin' },
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    const cc = data?.current_condition?.[0] || {};
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const forecastDay = data?.weather?.find(d => d.date === dateStr) || data?.weather?.[0] || {};

    return {
      tempF: parseFloat(cc.temp_F) || null,
      desc: cc.weatherDesc?.[0]?.value || 'Unknown',
      precipMm: parseFloat(cc.precipMM) || 0,
      forecast: [{
        date: forecastDay.date || dateStr,
        hourly: (forecastDay.hourly || []).slice(0, 8),
      }],
    };
  } catch {
    return null;
  }
}

if (require.main === module) {
  const w = fetchWeather();
  if (w) {
    console.log(JSON.stringify(w, null, 2));
  } else {
    console.error('Failed to fetch weather');
    process.exit(1);
  }
}

module.exports = { fetchWeather };
