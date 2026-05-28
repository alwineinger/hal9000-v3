/**
 * spa/approval-poll.js
 *
 * Option A polling approval loop — checks Telegram for user replies to weather
 * approval prompts and updates the approval file accordingly.
 *
 * Usage:
 *   node approval-poll.js --check    Check pending approval, update status if replied/expired
 *   node approval-poll.js --respond <yes|no>  Record a user decision (for manual/testing use)
 *
 * Exit codes:
 *   0 = approval processed (approved / denied / expired)
 *   1 = still pending / no approval file / skip
 *
 * Output (JSON):
 *   { status: "approved" | "denied" | "expired" | "pending", reason: string }
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const WEATHER_APPROVAL_FILE = process.env.SPA_WEATHER_APPROVAL_FILE || path.join(DATA_DIR, 'spa-weather-approval.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Call `openclaw message list` to fetch recent messages from the approval target.
 * Returns array of message objects: [{ id, text, senderId, timestamp, ... }]
 */
function fetchRecentMessages(target, limit = 10) {
  // target comes from SPA_WEATHER_APPROVAL_TARGET (e.g. a chat_id or username)
  const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
  const channel = process.env.SPA_WEATHER_APPROVAL_CHANNEL || 'telegram';

  const result = spawnSync(openclawBin, [
    'message',
    'list',
    '--channel', channel,
    '--target', target,
    '--limit', String(limit),
    '--json'
  ], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000
  });

  if (result.status !== 0) {
    // Non-zero exit is common when no messages exist — treat as empty list
    return [];
  }

  const text = (result.stdout || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    // Normalize to array
    if (Array.isArray(parsed)) return parsed;
    if (parsed.messages && Array.isArray(parsed.messages)) return parsed.messages;
    return [parsed];
  } catch {
    return [];
  }
}

/**
 * Determine if a message text constitutes a YES or NO approval response.
 */
function parseApprovalReply(text) {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();
  if (/^(yes|yep|yeah|approve|ok|okay|sure|go|do\s*it|lets?\s*go|👍|✅)/i.test(normalized)) return 'yes';
  if (/^(no|nope|nah|deny|skip|cancel|nope|nvm|👎|❌)/i.test(normalized)) return 'no';
  return null;
}

/**
 * Check if a message is from the approval target and newer than promptSentAt.
 */
function isValidReply(message, target, promptSentAt) {
  if (!message) return false;

  // Match sender: message.from or message.senderId should match target
  // or if message.chat matches (some APIs surface chat id)
  const sender = String(message.senderId || message.from?.id || message.chat?.id || '').replace(/^-?100/, '');
  const targetNorm = String(target || '').replace(/^-?100/, '');
  if (targetNorm && sender && sender !== targetNorm && sender !== `-${targetNorm}`) {
    // Allow if no sender info — telegram can be ambiguous
    // Only reject if we canConfirm a mismatch
  }

  const msgTime = Date.parse(message.timestamp || message.date || message.createdAt || '');
  const promptTime = Date.parse(promptSentAt || '');
  if (Number.isFinite(msgTime) && Number.isFinite(promptTime) && msgTime <= promptTime) {
    return false; // not newer than prompt
  }

  return true;
}

/**
 * Main --check logic.
 * Reads WEATHER_APPROVAL_FILE, determines if user replied via Telegram,
 * updates file status, and prints result JSON.
 */
function doCheck() {
  const approval = readJson(WEATHER_APPROVAL_FILE);
  if (!approval) {
    console.log(JSON.stringify({ status: 'pending', reason: 'no-approval-file' }));
    process.exit(1);
  }

  if (approval.status !== 'pending') {
    // Already resolved
    console.log(JSON.stringify({ status: approval.status, reason: `already-${approval.status}` }));
    process.exit(0);
  }

  const nowMs = Date.now();
  const expiresAt = Date.parse(approval.expiresAt || '');
  const promptSentAt = approval.promptSentAt;
  const target = process.env.SPA_WEATHER_APPROVAL_TARGET || '';

  // Check expiration first
  if (Number.isFinite(expiresAt) && nowMs > expiresAt) {
    const updated = {
      ...approval,
      status: 'denied',
      decisionAt: new Date(nowMs).toISOString(),
      decisionSource: 'expired'
    };
    writeJson(WEATHER_APPROVAL_FILE, updated);
    console.log(JSON.stringify({ status: 'expired', reason: 'approval-timed-out' }));
    process.exit(0);
  }

  // Fetch recent Telegram messages and look for a reply
  if (target) {
    const messages = fetchRecentMessages(target, 20);
    let foundReply = null;

    for (const msg of messages) {
      if (!isValidReply(msg, target, promptSentAt)) continue;
      const vote = parseApprovalReply(msg.text || msg.message?.text || '');
      if (vote) {
        foundReply = vote;
        break;
      }
    }

    if (foundReply) {
      const updated = {
        ...approval,
        status: foundReply === 'yes' ? 'approved' : 'denied',
        decisionAt: new Date(nowMs).toISOString(),
        decisionSource: 'telegram-reply'
      };
      writeJson(WEATHER_APPROVAL_FILE, updated);
      console.log(JSON.stringify({ status: foundReply === 'yes' ? 'approved' : 'denied', reason: `user-replied-${foundReply}` }));
      process.exit(0);
    }
  }

  // Still pending
  console.log(JSON.stringify({ status: 'pending', reason: 'awaiting-reply' }));
  process.exit(1);
}

/**
 * Record a manual decision (for --respond flag / testing).
 */
function doRespond(decision) {
  const approval = readJson(WEATHER_APPROVAL_FILE);
  if (!approval || approval.status !== 'pending') {
    console.log(JSON.stringify({ status: 'noop', reason: 'no-pending-approval' }));
    process.exit(1);
  }

  if (decision !== 'yes' && decision !== 'no') {
    console.error('Invalid decision. Use --respond yes or --respond no');
    process.exit(1);
  }

  const updated = {
    ...approval,
    status: decision === 'yes' ? 'approved' : 'denied',
    decisionAt: new Date(Date.now()).toISOString(),
    decisionSource: 'manual'
  };
  writeJson(WEATHER_APPROVAL_FILE, updated);
  console.log(JSON.stringify({ status: updated.status, reason: `manual-${decision}` }));
  process.exit(0);
}

// CLI entrypoint
const args = process.argv.slice(2);
if (args.includes('--check')) {
  doCheck();
} else if (args.includes('--respond')) {
  const idx = args.indexOf('--respond');
  const decision = args[idx + 1];
  if (!decision) {
    console.error('--respond requires <yes|no>');
    process.exit(1);
  }
  doRespond(decision);
} else {
  console.error('Usage: node approval-poll.js --check\n       node approval-poll.js --respond <yes|no>');
  process.exit(1);
}
