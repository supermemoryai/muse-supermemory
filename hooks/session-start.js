const { getProfile } = require('./lib/api');
const { getNamespace, getProjectName } = require('./lib/namespace');
const { loadProjectConfig } = require('./lib/project-config');
const {
  loadSettings,
  getAuthToken,
  getBaseUrl,
  getMcpUrl,
  debugLog,
} = require('./lib/settings');
const { BRAND, bold, gray } = require('./lib/colors');
const { readStdin, writeOutput } = require('./lib/stdin');
const {
  LOGIN_COMMAND,
  credentialsFile,
  getOAuthConfig,
  settleAuth,
  startAuthFlow,
} = require('./lib/auth');
const { getUserFriendlyError } = require('./lib/error-helpers');
const { lastSessionFile } = require('./lib/last-session');
const fs = require('node:fs');

function welcomeBackNotice(namespace) {
  try {
    const last = JSON.parse(fs.readFileSync(lastSessionFile(), 'utf-8'));
    if (!last.savedAt || (last.namespace || last.containerTag) !== namespace) return null;
    const hours = (Date.now() - new Date(last.savedAt).getTime()) / 3600000;
    if (hours < 6) return null;
    const ago =
      hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
    return `welcome back — last session here ${ago}`;
  } catch {
    return null;
  }
}

function formatContext(profileResult, maxItems, namespace, projectName) {
  const statics = (profileResult?.profile?.static || []).slice(0, maxItems);
  const dynamics = (profileResult?.profile?.dynamic || []).slice(0, maxItems);
  if (statics.length === 0 && dynamics.length === 0) return null;

  const sections = [];
  if (statics.length > 0) {
    sections.push(
      `## User Profile (Persistent)\n${statics.map((f) => `- ◪ ${f.memory}`).join('\n')}`,
    );
  }
  if (dynamics.length > 0) {
    sections.push(
      `## Recent Context\n${dynamics.map((f) => `- ◪ ${f.memory}`).join('\n')}`,
    );
  }

  return `<supermemory-context>
Recalled memory for this project (${projectName}). Every line marked ◪ comes from supermemory — when citing one, keep the mark and phrase it naturally (e.g. "◪ last week you told me about X"). If you name the source, say "from supermemory" — never "from memory".
This project's memory namespace: ${namespace}

${sections.join('\n\n')}
</supermemory-context>`;
}

function output(additionalContext, systemMessageParts) {
  const systemMessage = systemMessageParts.filter(Boolean).join('\n');
  writeOutput({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
}

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const cwd = input.cwd || process.cwd();
    const projectConfig = loadProjectConfig(cwd);
    const projectName = getProjectName(cwd);
    const namespace = getNamespace(cwd);

    debugLog(settings, 'SessionStart', { cwd, projectName, namespace });

    const authStartedAt = Date.now();
    let apiKey;
    try {
      apiKey = await getAuthToken(cwd, projectConfig);
    } catch (error) {
      if (error.code !== 'AUTH_REQUIRED') throw error;
      try {
        apiKey = await startAuthFlow(
          getOAuthConfig(
            getBaseUrl(cwd, projectConfig),
            getMcpUrl(cwd, projectConfig),
          ),
          { timeoutMs: Math.max(1, 25000 - (Date.now() - authStartedAt)) },
        );
      } catch (authErr) {
        output(
          `<supermemory-status>
${authErr.message === 'AUTH_TIMEOUT' ? 'Authentication timed out. Start a new session to retry login.' : 'Authentication failed. Start a new session to retry login.'}
For an explicit login, run: ${LOGIN_COMMAND}
Or write an API key to ${credentialsFile()} as {"apiKey":"sm_..."}.
</supermemory-status>`,
          [],
        );
        return;
      }
    }

    const baseUrl = getBaseUrl(cwd, projectConfig);

    let profileResult = null;
    let apiError = null;
    try {
      profileResult = await getProfile(baseUrl, apiKey, namespace);
    } catch (err) {
      if (err?.status !== 404) apiError = getUserFriendlyError(err);
      debugLog(settings, 'Profile fetch failed', { error: err.message });
    }

    const context = formatContext(
      profileResult,
      settings.maxProfileItems,
      namespace,
      projectName,
    );
    const loaded =
      Math.min(profileResult?.profile?.static?.length || 0, settings.maxProfileItems) +
      Math.min(profileResult?.profile?.dynamic?.length || 0, settings.maxProfileItems);

    const memoryNotice =
      loaded > 0
        ? `${BRAND} ${gray('·')} ${loaded} ${loaded === 1 ? 'memory' : 'memories'} loaded for ${bold(projectName)}`
        : null;

    output(
      (apiError ? `<supermemory-status>\n${apiError}\n</supermemory-status>\n` : '') +
        (context ||
          (apiError
            ? `<supermemory-context>
Memory could not be loaded this session — do not assume this project has no memories.
</supermemory-context>`
            : `<supermemory-context>
No previous memories found for this project (namespace: ${namespace}).
Memories will be saved as you work.
</supermemory-context>`)),
      [[memoryNotice, welcomeBackNotice(namespace)].filter(Boolean).join(gray(' · ')) || null],
    );
  } catch (err) {
    const friendly = getUserFriendlyError(err);
    console.error(`Supermemory: ${friendly}`);
    output(
      `<supermemory-status>
Failed to load memories: ${friendly}
Session will continue without memory context.
</supermemory-status>`,
      [],
    );
  }
}

module.exports = { formatContext };

if (require.main === module) {
  main().catch(async (err) => {
    console.error(`Supermemory fatal: ${err.message}`);
    await settleAuth();
    process.exit(1);
  });
}
