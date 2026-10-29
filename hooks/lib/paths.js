const os = require('node:os');
const path = require('node:path');

function settingsDir() {
  return (
    process.env.SUPERMEMORY_MUSE_HOME ||
    path.join(os.homedir(), '.supermemory-muse')
  );
}

function claudeCredentialsFile() {
  return path.join(os.homedir(), '.supermemory-claude', 'credentials.json');
}

module.exports = {
  settingsDir,
  settingsFile: () => path.join(settingsDir(), 'settings.json'),
  credentialsFile: () => path.join(settingsDir(), 'credentials.json'),
  oauthClientFile: () => path.join(settingsDir(), 'oauth-client.json'),
  authLockFile: () => path.join(settingsDir(), 'auth.lock'),
  lastSessionFile: () => path.join(settingsDir(), 'last-session.json'),
  claudeCredentialsFile,
};
