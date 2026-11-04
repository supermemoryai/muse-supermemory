const { addMemory, AGENT_SUPPORTING_CONTEXT } = require('./lib/api');
const {
  getNamespace,
  getProjectIdentity,
  getProjectName,
} = require('./lib/namespace');
const { loadProjectConfig } = require('./lib/project-config');
const { loadSettings, getAuthToken, getBaseUrl, debugLog } = require('./lib/settings');
const { settleAuth } = require('./lib/auth');
const { readStdin, writeOutput } = require('./lib/stdin');
const {
  formatNewEntries,
  setLastCapturedSequence,
  resolveTranscriptPath,
} = require('./lib/transcript');
const { getUserFriendlyError } = require('./lib/error-helpers');
const { saveLastSession } = require('./lib/last-session');

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const cwd = input.cwd || process.cwd();
    const sessionId = input.session_id;
    const transcriptPath = resolveTranscriptPath(input);
    const projectConfig = loadProjectConfig(cwd);

    if (!transcriptPath || !sessionId) {
      writeOutput({ continue: true });
      return;
    }

    let apiKey;
    try {
      apiKey = await getAuthToken(cwd, projectConfig);
    } catch {
      writeOutput({ continue: true });
      return;
    }

    const delta = formatNewEntries(transcriptPath, sessionId);
    if (!delta) {
      debugLog(settings, 'No new content to save');
      writeOutput({ continue: true });
      return;
    }

    const baseUrl = getBaseUrl(cwd, projectConfig);
    const namespace = getNamespace(cwd);

    const result = await addMemory(
      baseUrl,
      apiKey,
      delta.formatted,
      namespace,
      {
        type: 'session_turn',
        project: getProjectName(cwd),
        sm_project_id: getProjectIdentity(cwd),
        sm_scope: 'personal',
        sm_capture_mode: 'automatic',
        timestamp: new Date().toISOString(),
      },
      { id: sessionId, supportingContext: AGENT_SUPPORTING_CONTEXT },
    );

    if (delta.lastSequence != null) {
      setLastCapturedSequence(sessionId, delta.lastSequence);
    }

    if (result?.id) {
      try {
        saveLastSession({ id: result.id, namespace });
      } catch {}
    }

    debugLog(settings, 'Session turn saved', { length: delta.formatted.length });
    writeOutput({ continue: true });
  } catch (err) {
    const friendly = getUserFriendlyError(err);
    debugLog(settings, 'Capture error', { error: friendly });
    console.error(`Supermemory: ${friendly}`);
    writeOutput({ continue: true });
  }
}

main().catch(async (err) => {
  console.error(`Supermemory fatal: ${err.message}`);
  await settleAuth();
  process.exit(1);
});
