const path = require('node:path');

function getUserFriendlyError(err) {
  const status = err?.status;

  if (
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError' ||
    err?.message === 'fetch failed'
  ) {
    return 'Supermemory unreachable (network) — continuing without memory.';
  }
  if (status === 400) {
    return 'Bad request — your API key or request format may be invalid. Check your key at https://console.supermemory.ai';
  }
  if (status === 401) {
    return `Authentication failed — your credentials may be expired or revoked. Log in again with: node "${path.join(__dirname, 'auth.js')}" login, or check your configured API key.`;
  }
  if (status === 403) {
    return 'Permission denied — this feature may require a different Supermemory plan. Check https://supermemory.ai/pricing';
  }
  if (status === 429) {
    return 'Rate limited — too many requests. Will retry next session.';
  }
  if (typeof status === 'number' && status >= 500) {
    return 'Supermemory service is temporarily unavailable. Will retry next session.';
  }

  return err?.message || 'Unknown error';
}

module.exports = { getUserFriendlyError };
