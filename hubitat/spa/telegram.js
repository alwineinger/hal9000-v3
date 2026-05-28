/**
 * spa/telegram.js
 * Thin boundary for Telegram weather approval messaging.
 *
 * IMPORTANT: This is the ONLY module permitted to perform external messaging
 * or invoke LLM-assisted logic for the Telegram path.
 *
 * Current implementation uses the pure `openclaw message send` CLI and does NOT
 * contain any LLM calls. If LLM usage is ever required for prompt generation or
 * response interpretation, it MUST be added only inside this file and must be
 * feature-gated behind SPA_ALLOW_LLM=1.
 */

const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');

function sendWeatherApprovalPrompt(approval, nowMs) {
  const cfg = loadConfig();

  if (!cfg.weatherApprovalNotify) {
    return {
      ok: false,
      skipped: true,
      reason: 'SPA_WEATHER_APPROVAL_NOTIFY is not enabled'
    };
  }

  if (!cfg.weatherApprovalTarget) {
    return {
      ok: false,
      skipped: true,
      reason: 'SPA_WEATHER_APPROVAL_TARGET is not configured'
    };
  }

  const promptText = approval?.promptText || 'Rain/storm check for the Spa preheat. Reply YES to continue heating, or NO to skip it. Default is YES if you do not respond.';

  const result = spawnSync(cfg.openclawBin, [
    'message',
    'send',
    '--channel', cfg.weatherApprovalChannel,
    '--target', cfg.weatherApprovalTarget,
    '--message', promptText,
    '--json'
  ], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });

  if (result.status !== 0) {
    return {
      ok: false,
      command: cfg.openclawBin,
      status: result.status,
      error: (result.stderr || result.stdout || '').trim()
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch (e) {
    parsed = { raw: (result.stdout || '').trim() };
  }

  return {
    ok: true,
    channel: cfg.weatherApprovalChannel,
    target: cfg.weatherApprovalTarget,
    sentAt: new Date(nowMs).toISOString(),
    result: parsed
  };
}

module.exports = {
  sendWeatherApprovalPrompt,
};
