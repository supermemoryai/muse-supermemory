const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getProfile } = require('./lib/api');
const { BRAND, gray, red } = require('./lib/colors');
const { getContainerTag } = require('./lib/container-tag');
const { getUserFriendlyError } = require('./lib/error-helpers');
const { loadProjectConfig } = require('./lib/project-config');
const {
  loadSettings,
  getAuthToken,
  getBaseUrl,
  debugLog,
  getRecallConfig,
} = require('./lib/settings');
const { atomicWriteJson, getSessionDir, readJson } = require('./lib/session-state');
const { readStdin, writeOutput } = require('./lib/stdin');

const MIN_PROMPT_LENGTH = 12;
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 5;
const MAX_RESULT_CHARS = 300;
const MIN_SIMILARITY = 0.55;
const SEARCH_TIMEOUT_MS = 4000;
const MAX_SEEN_HASHES = 500;
const DISCOVERY_MARKER = 'discovery.json';

function shouldSkip(prompt) {
  if (prompt.length < MIN_PROMPT_LENGTH) return true;
  return ['/', '!', '#'].includes(prompt[0]);
}

function resultText(r) {
  const text = [r?.memory, r?.chunk, r?.content, r?.text].find(
    (v) => typeof v === 'string' && v.trim(),
  );
  return text || null;
}

function hashText(text) {
  return crypto
    .createHash('sha256')
    .update(text.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);
}

function readSeenHashes(sessionDir) {
  const list = readJson(path.join(sessionDir, 'recalled.json'), []);
  return Array.isArray(list) ? list.filter((h) => typeof h === 'string') : [];
}

function discoverySent(sessionDir) {
  return fs.existsSync(path.join(sessionDir, DISCOVERY_MARKER));
}

function markDiscoverySent(sessionDir) {
  try {
    atomicWriteJson(path.join(sessionDir, DISCOVERY_MARKER), {
      sentAt: new Date().toISOString(),
    });
  } catch {}
}

function formatDiscovery(containerTag) {
  return `<supermemory-recall>
No stored memories matched this prompt for this project.

Deeper history may still exist. Search it with the supermemory search_memory tool.

- Scope to this project with containerTag: "${containerTag}"
- Omit containerTag to search the account's active/shared space instead.
- Read-only supermemory calls are auto-approved; they never prompt the user.

Worth a call when the user refers to past decisions, earlier sessions, or says
"remember" / "we decided" / "last time". Skip it for self-contained tasks.
</supermemory-recall>`;
}

function formatRecall(results, containerTag) {
  const lines = results.map((r) => {
    const text = resultText(r).replace(/\s+/g, ' ').slice(0, MAX_RESULT_CHARS);
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null;
    const prefix = title && !text.startsWith(title) ? `${title} — ` : '';
    return `- ◪ ${prefix}${text}${typeof r.filepath === 'string' && r.filepath ? ` (${r.filepath})` : ''}`;
  });
  return `<supermemory-recall>
◪ Recalled from supermemory for this prompt (relevance-ranked):
${lines.join('\n')}

When one of these shapes your answer, credit it naturally with the ◪ prefix (e.g. "◪ earlier you decided X"); if you name the source, say "from supermemory" — never "from memory". For deeper history, call the supermemory search_memory tool (containerTag: "${containerTag}").
</supermemory-recall>`;
}

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const cwd = input.cwd || process.cwd();
    const prompt = (input.prompt || '').trim();
    const { directive } = getRecallConfig(cwd);

    if (directive) {
      writeOutput({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: directive,
        },
      });
      return;
    }

    if (shouldSkip(prompt)) {
      writeOutput({ continue: true, suppressOutput: true });
      return;
    }

    const projectConfig = loadProjectConfig(cwd);
    const requestStarted = Date.now();
    let apiKey;
    try {
      apiKey = await getAuthToken(cwd, projectConfig, 1000);
    } catch {
      writeOutput({ continue: true, suppressOutput: true });
      return;
    }

    const containerTag = getContainerTag(cwd);
    const response = await getProfile(
      getBaseUrl(cwd, projectConfig),
      apiKey,
      containerTag,
      prompt.slice(0, MAX_QUERY_LENGTH),
      {
        timeoutMs: Math.max(1, SEARCH_TIMEOUT_MS - (Date.now() - requestStarted)),
      },
    );

    const results = (response?.searchResults?.results || [])
      .filter((r) => resultText(r))
      .filter((r) => !Number.isFinite(r.similarity) || r.similarity >= MIN_SIMILARITY)
      .slice(0, MAX_RESULTS);

    const sessionDir = getSessionDir(input.session_id);
    const seen = sessionDir ? readSeenHashes(sessionDir) : [];
    const seenSet = new Set(seen);
    const fresh = results.filter((r) => !seenSet.has(hashText(resultText(r))));
    const repeats = results.length - fresh.length;

    debugLog(settings, 'Prompt recall', {
      query: prompt.slice(0, 80),
      hits: results.length,
      fresh: fresh.length,
    });

    if (fresh.length === 0) {
      if (results.length === 0 && sessionDir && !discoverySent(sessionDir)) {
        markDiscoverySent(sessionDir);
        writeOutput({
          systemMessage: `${BRAND} ${gray('·')} no memories yet for this project`,
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: formatDiscovery(containerTag),
          },
        });
        return;
      }
      writeOutput({ continue: true, suppressOutput: true });
      return;
    }

    if (sessionDir) {
      try {
        atomicWriteJson(
          path.join(sessionDir, 'recalled.json'),
          [...seen, ...fresh.map((r) => hashText(resultText(r)))].slice(-MAX_SEEN_HASHES),
        );
      } catch {}
    }

    const context = formatRecall(fresh, containerTag);
    const tok = gray(`(${Math.round(context.length / 4)} tok)`);
    const label = repeats
      ? `recalled ${fresh.length} new ${tok}${gray(` · ${repeats} already in context`)}`
      : `recalled ${fresh.length} ${fresh.length === 1 ? 'memory' : 'memories'} ${tok}`;
    writeOutput({
      systemMessage: `${BRAND} ${gray('·')} ${label}`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    });
  } catch (err) {
    debugLog(settings, 'Recall error', { error: err.message });
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      writeOutput({ continue: true, suppressOutput: true });
      return;
    }
    writeOutput({
      systemMessage: `${BRAND} ${gray('·')} ${red(`recall failed: ${getUserFriendlyError(err).slice(0, 80)}`)}`,
      continue: true,
      suppressOutput: true,
    });
  }
}

main().catch(() => {
  writeOutput({ continue: true, suppressOutput: true });
});
