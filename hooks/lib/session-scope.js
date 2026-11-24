const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ENV_TRUE = new Set(['true', '1', 'yes', 'on']);
const ENV_FALSE = new Set(['false', '0', 'no', 'off']);

// The environment wins over settings.json in both directions.
function optedIn(envName, setting) {
  const value = process.env[envName]?.trim().toLowerCase();
  if (ENV_TRUE.has(value)) return true;
  if (ENV_FALSE.has(value)) return false;
  return setting === true;
}

// Muse sets MUSE_THREAD_ID to the chat or subagent a hook fires for and MUSE_SESSION_ID to its top-level chat.
function isSubagent() {
  const { MUSE_SESSION_ID: session, MUSE_THREAD_ID: thread } = process.env;
  return Boolean(session && thread && session !== thread);
}

// Plugin hooks are spawned by the muse binary itself, so its argv names the subcommand.
function hostArgs() {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0');
    }
    if (process.platform === 'win32') return [];
    return execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], {
      encoding: 'utf8',
      timeout: 1000,
    })
      .trim()
      .split(/\s+/);
  } catch {
    return [];
  }
}

function isHeadless(args = hostArgs()) {
  return args[1] === 'exec';
}

function skipReason(settings) {
  if (isSubagent() && !optedIn('SUPERMEMORY_CAPTURE_SUBAGENTS', settings.captureSubagents)) {
    return 'subagent';
  }
  if (!optedIn('SUPERMEMORY_CAPTURE_HEADLESS', settings.captureHeadless) && isHeadless()) {
    return 'headless';
  }
  return null;
}

module.exports = { isHeadless, isSubagent, skipReason };
