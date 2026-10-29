const { BRAND, gray } = require('./lib/colors');
const { loadSettings, debugLog } = require('./lib/settings');
const { readStdin, writeOutput } = require('./lib/stdin');

const READ_ONLY_TOOLS = new Set([
  'search_memory',
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
    // Any other tool: no output, so Muse applies its normal approval. Muse 1.4.4 rejects
    // `continue` in PreToolUse output and logs the hook as failed on every tool call.
  } catch (err) {
    debugLog(settings, 'Recall approve error', { error: err.message });
  }
}

main().catch(() => {});
