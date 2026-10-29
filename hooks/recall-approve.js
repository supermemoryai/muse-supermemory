const { BRAND, gray } = require('./lib/colors');
const { loadSettings, debugLog } = require('./lib/settings');
const { readStdin, writeOutput } = require('./lib/stdin');

const READ_ONLY_TOOLS = new Set([
  'search_memory',
  'get_profile',
  'list_documents',
  'get_document',
  'list_memories',
  'list_spaces',
  'who_am_i',
  'listSpaces',
  'listMemories',
  'listDocuments',
  'getDocument',
  'whoAmI',
  'memory-graph',
  'fetch-graph-data',
]);

function supermemoryTool(name) {
  if (typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  if (!lower.includes('supermemory')) return null;
  const parts = name.split(/__+|:+|\./);
  return parts.at(-1) || null;
}

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const tool = supermemoryTool(input.tool_name || '');

    if (tool && READ_ONLY_TOOLS.has(tool)) {
      debugLog(settings, 'Auto-approving supermemory recall', { tool });
      const query =
        typeof input.tool_input?.query === 'string'
          ? input.tool_input.query
          : null;
      writeOutput({
        systemMessage: query
          ? `${BRAND} ${gray('·')} recalling: ${query}`
          : `${BRAND} ${gray('·')} recalling memories`,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'Supermemory recall runs automatically (read-only memory access).',
        },
      });
      return;
    }

    writeOutput({ continue: true, suppressOutput: true });
  } catch (err) {
    debugLog(settings, 'Recall approve error', { error: err.message });
    writeOutput({ continue: true, suppressOutput: true });
  }
}

main().catch(() => {
  writeOutput({ continue: true, suppressOutput: true });
});
