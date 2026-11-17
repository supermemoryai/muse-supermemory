const { addSession, AGENT_SUPPORTING_CONTEXT } = require('./lib/api');
const {
  getNamespace,
  getProjectIdentity,
  getProjectName,
} = require('./lib/namespace');
const { loadProjectConfig } = require('./lib/project-config');
const { loadSettings, getAuthToken, getBaseUrl, debugLog } = require('./lib/settings');
const { settleAuth } = require('./lib/auth');
const { readStdin, writeOutput } = require('./lib/stdin');
const { readRawDelta, resolveTranscriptPath } = require('./lib/transcript');
const { getUserFriendlyError } = require('./lib/error-helpers');
const { saveLastSession } = require('./lib/last-session');

const CAPTURE_TIMEOUT_MS = 25000;

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

    const delta = readRawDelta(transcriptPath, sessionId);
    if (!delta) {
      debugLog(settings, 'No new content to save');
      writeOutput({ continue: true });
      return;
    }

    const baseUrl = getBaseUrl(cwd, projectConfig);
    const namespace = getNamespace(cwd);

    const result = await addSession(
      baseUrl,
      apiKey,
      delta.raw,
      namespace,
      {
        type: 'session_turn',
        project: getProjectName(cwd),
        sm_project_id: getProjectIdentity(cwd),
        sm_scope: 'personal',
        sm_capture_mode: 'automatic',
        timestamp: new Date().toISOString(),
      },
      {
        id: sessionId,
        generation: delta.generation,
        offset: delta.offset,
        supportingContext: AGENT_SUPPORTING_CONTEXT,
        timeoutMs: CAPTURE_TIMEOUT_MS,
      },
    );

    delta.commit();

    if (result?.id) {
      try {
        saveLastSession({ id: result.id, namespace });
      } catch {}
    }

    debugLog(settings, 'Session sent', {
      bytes: delta.raw.length,
      generation: delta.generation,
      offset: delta.offset,
    });
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
