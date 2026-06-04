/**
 * spa/weather-fetch.js
 * Fetches current weather + 48-hour forecast from OpenWeather API for Tampa FL.
 * Pure I/O module — no business logic.
 *
 * Output shape (backwards-compatible with scheduler.js):
 * {
 *   tempF: number,
 *   desc: string,
 *   precipMm: number,
 *   forecast: [{
 *     date: 'YYYY-MM-DD',
 *     hourly: [{ time: 'HHMM', desc, chanceofrain, chanceofthunder }]
 *   }]
 * }
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_KEY = fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'secrets', 'openweather-api.txt'), 'utf8').trim() || 'DEMO_KEY';
const LAT = '28.0375';
const LON = '-82.4246';
const ONE_CALL_URL = `https://api.openweathermap.org/data/3.0/onecall?lat=${LAT}&lon=${LON}&exclude=minutely,alerts&units=imperial&appid=${API_KEY}`;
const FORECAST_URL = `https://api.openweathermap.org/data/2.5/forecast?lat=${LAT}&lon=${LON}&units=imperial&appid=${API_KEY}`;

/**
 * Fetch from a URL using curl (same pattern as old wttr.in approach).
 */
function curlJson(url) {
  const result = spawnSync('curl', ['-s', '--connect-timeout', '10', url], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Parse a Unix timestamp (seconds) into a YYYY-MM-DD date string in local time.
 */
function timestampToDate(unixMs) {
  return new Date(unixMs * 1000).toISOString().split('T')[0];
}

/**
 * Format hour from a Date object as HHMM string (e.g. 1500 for 3pm).
 */
function formatHour(date) {
  return date.getHours().toString().padStart(2, '0') + '00';
}

/**
 * Estimate thunder chance from OpenWeather weather code.
 * OpenWeather codes: 200-232 = Thunderstorm, 900 = Extreme Thunderstorm.
 * Returns a string percentage.
 */
function thunderChanceFromCode(code) {
  if (!Number.isFinite(code)) return '0';
  if (code >= 200 && code < 300) return '60'; // Thunderstorm
  if (code === 900) return '80';              // Extreme
  return '0';
}

/**
 * Map OpenWeather One Call response to the required output shape.
 */
function transformOneCall(data) {
  const current = data.current || {};
  const hourly = data.hourly || [];

  // Current conditions
  const tempF = Number.isFinite(current.temp) ? Math.round(current.temp) : null;
  const desc = current.weather?.[0]?.description || 'Unknown';
  const precipMm = current.rain?.['1h'] != null ? current.rain['1h']
    : current.snow?.['1h'] != null ? current.snow['1h']
    : 0;

  // Group hourly forecast by date
  const byDate = {};
  for (const h of hourly) {
    const dateStr = timestampToDate(h.dt);
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push(h);
  }

  // Build forecast array — up to 3 days
  const forecast = Object.keys(byDate)
    .sort()
    .slice(0, 3)
    .map(dateStr => ({
      date: dateStr,
      hourly: byDate[dateStr].map(h => {
        const hourDate = new Date(h.dt * 1000);
        const time = formatHour(hourDate);
        const pop = h.pop != null ? Math.round(h.pop * 100) : 0;
        const weatherCode = h.weather?.[0]?.id;
        // If thunderstorm code, use that as thunder chance; otherwise use pop
        const thunderStr = thunderChanceFromCode(weatherCode);
        const chanceThunder = thunderStr !== '0' ? thunderStr : String(pop);
        return {
          atMs: h.dt * 1000,
          time,
          tempF: Math.round(h.temp),
          desc: h.weather?.[0]?.description || '',
          chanceofrain: String(pop),
          chanceofthunder: chanceThunder,
        };
      }),
    }));

  return { tempF, desc, precipMm, forecast };
}

/**
 * Fallback: fetch 5-day/3-hour forecast and group into days.
 * Less ideal than One Call but available on free tier.
 */
function transformForecast(data) {
  const list = data?.list || [];
  const byDate = {};
  for (const item of list) {
    const dateStr = timestampToDate(item.dt);
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push(item);
  }

  // Take first 3 days
  const forecast = Object.keys(byDate)
    .sort()
    .slice(0, 3)
    .map(dateStr => ({
      date: dateStr,
      hourly: byDate[dateStr].map(item => {
        const hourDate = new Date(item.dt * 1000);
        const time = formatHour(hourDate);
        const pop = item.pop != null ? Math.round(item.pop * 100) : 0;
        const weatherCode = item.weather?.[0]?.id;
        const thunderStr = thunderChanceFromCode(weatherCode);
        const chanceThunder = thunderStr !== '0' ? thunderStr : String(pop);
        return {
          atMs: item.dt * 1000,
          time,
          tempF: Math.round(item.main?.temp),
          desc: item.weather?.[0]?.description || '',
          chanceofrain: String(pop),
          chanceofthunder: chanceThunder,
        };
      }),
    }));

  // Current conditions from first entry
  const first = list[0] || {};
  const tempF = Math.round(first.main?.temp);
  const desc = first.weather?.[0]?.description || 'Unknown';
  const precipMm = first.rain?.['3h'] != null ? first.rain['3h'] / 3
    : first.snow?.['3h'] != null ? first.snow['3h'] / 3
    : 0;

  return { tempF, desc, precipMm, forecast };
}

/**
 * Main fetch: try One Call API first, fall back to /forecast, return null on failure.
 */
function fetchWeather() {
  // Try One Call API 3.0 (preferred)
  let data = curlJson(ONE_CALL_URL);
  if (data && (data.cod === 200 || data.cod === '200') && !data.error) {
    return transformOneCall(data);
  }

  // Fall back to 5-day /forecast (free tier, no daily agg needed)
  data = curlJson(FORECAST_URL);
  if (data && (data.cod === 200 || data.cod === '200') && !data.error) {
    return transformForecast(data);
  }

  return null;
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
