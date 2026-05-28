/**
 * spa/utils.js
 * Small pure utility helpers used across the spa modules.
 */

function parseIntOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function temperature(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bucket(value, size) {
  if (!Number.isFinite(value) || size <= 0) return null;
  return Math.round(value / size) * size;
}

function round(value, digits = 1) {
  return Number(Number(value).toFixed(digits));
}

function toIsoWithLocalOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0');
  const minutes = String(absoluteMinutes % 60).padStart(2, '0');
  const localIso = new Date(date.getTime() - (date.getTimezoneOffset() * 60 * 1000)).toISOString().replace('Z', '');
  return `${localIso}${sign}${hours}:${minutes}`;
}

module.exports = {
  parseIntOrNull,
  temperature,
  bucket,
  round,
  toIsoWithLocalOffset,
};
