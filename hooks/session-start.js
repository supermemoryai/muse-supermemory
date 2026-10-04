const { getProfile } = require('./lib/api');
const { getContainerTag, getProjectName } = require('./lib/container-tag');
const { loadProjectConfig } = require('./lib/project-config');
const {
  loadSettings,
  getApiKey,
  getBaseUrl,
  isCustomBaseUrl,
  debugLog,
} = require('./lib/settings');
const { BRAND, bold, gray } = require('./lib/colors');
const { readStdin, writeOutput } = require('./lib/stdin');
const { startAuthFlow, AUTH_BASE_URL } = require('./lib/auth');
const { getUserFriendlyError } = require('./lib/error-helpers');
const { lastSessionFile } = require('./lib/last-session');
const fs = require('node:fs');

function welcomeBackNotice(containerTag) {
  try {
    const last = JSON.parse(fs.readFileSync(lastSessionFile(), 'utf-8'));
    if (!last.savedAt || last.containerTag !== containerTag) return null;
    const hours = (Date.now() - new Date(last.savedAt).getTime()) / 3600000;
    if (hours < 6) return null;
    const ago =
      hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
    return `welcome back — last session here ${ago}`;
  } catch {
    return null;
  }
}

function formatContext(profileResult, maxItems, containerTag, projectName) {
  const statics = (profileResult?.profile?.static || []).slice(0, maxItems);
  const dynamics = (profileResult?.profile?.dynamic || []).slice(0, maxItems);
  if (statics.length === 0 && dynamics.length === 0) return null;

  const sections = [];
  if (statics.length > 0) {
    sections.push(
      `## User Profile (Persistent)\n${statics.map((f) => `- ◪ ${f}`).join('\n')}`,
    );
  }
  if (dynamics.length > 0) {
    sections.push(
      `## Recent Context\n${dynamics.map((f) => `- ◪ ${f}`).join('\n')}`,
    );
  }

  return `<supermemory-context>
Recalled memory for this project (${projectName}). Every line marked ◪ comes from supermemory — when citing one, keep the mark and phrase it naturally (e.g. "◪ last week you told me about X"). If you name the source, say "from supermemory" — never "from memory".
This project's memory container: ${containerTag}

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
    const containerTag = getContainerTag(cwd);

    debugLog(settings, 'SessionStart', { cwd, projectName, containerTag });

    const baseUrl = getBaseUrl(cwd, projectConfig);

    let apiKey;
    try {
      apiKey = getApiKey(cwd, projectConfig);
    } catch {
      if (isCustomBaseUrl(baseUrl)) {
        // The hosted browser login cannot issue a key for a self-hosted server.
        output(
          `<supermemory-status>
No API key for ${baseUrl}. Write {"apiKey":"..."} to ~/.supermemory-muse/credentials.json.
</supermemory-status>`,
          [],
        );
        return;
      }
      try {
        apiKey = await startAuthFlow();
      } catch (authErr) {
        output(
          `<supermemory-status>
${authErr.message === 'AUTH_TIMEOUT' ? 'Authentication timed out. Please complete login in the browser window.' : 'Authentication failed.'}
If the browser did not open, visit: ${AUTH_BASE_URL}
Or write an API key to ~/.supermemory-muse/credentials.json as {"apiKey":"sm_..."}.
</supermemory-status>`,
          [],
        );
        return;
      }
    }

    let profileResult = null;
    let apiError = null;
    try {
      profileResult = await getProfile(baseUrl, apiKey, containerTag, projectName);
    } catch (err) {
      if (err?.status !== 404) apiError = getUserFriendlyError(err);
      debugLog(settings, 'Profile fetch failed', { error: err.message });
    }

    const context = formatContext(
      profileResult,
      settings.maxProfileItems,
      containerTag,
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
No previous memories found for this project (container: ${containerTag}).
Memories will be saved as you work.
</supermemory-context>`)),
      [[memoryNotice, welcomeBackNotice(containerTag)].filter(Boolean).join(gray(' · ')) || null],
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

main().catch((err) => {
  console.error(`Supermemory fatal: ${err.message}`);
  process.exit(1);
});
