#!/usr/bin/env node
const readline = require('node:readline');
const { getContainerTag } = require('../hooks/lib/container-tag');
const {
  LOGIN_COMMAND,
  credentialsFile,
  settleAuth,
} = require('../hooks/lib/auth');
const { getAuthToken, getMcpUrl } = require('../hooks/lib/settings');
const REQUEST_TIMEOUT_MS = 30000;

const REPO_SCOPED_TOOLS = new Set([
  'search_memory',
  'add_memory',
  'listDocuments',
  'listMemories',
  'memory-graph',
  'fetch-graph-data',
  'save-memory',
]);

let sessionId = null;

function injectRepoContainerTag(message, containerTag) {
  if (!containerTag || message.method !== 'tools/call') return;
  const params = message.params;
  if (!params || typeof params !== 'object') return;
  if (!REPO_SCOPED_TOOLS.has(params.name)) return;

  let args = params.arguments;
  let encoded = false;
  if (args == null) {
    params.arguments = { containerTag };
    return;
  }
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
      encoded = true;
    } catch {
      return;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  if (typeof args.containerTag === 'string' && args.containerTag.trim()) return;

  args.containerTag = containerTag;
  params.arguments = encoded ? JSON.stringify(args) : args;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function emitSseData(text) {
  for (const event of text.split('\n\n')) {
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) process.stdout.write(`${data}\n`);
      }
    }
  }
}

async function forward(message, apiKey, mcpUrl) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const newSessionId = response.headers.get('mcp-session-id');
  if (newSessionId) sessionId = newSessionId;

  if (response.status === 202) return;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    sendError(
      message.id,
      -32000,
      `Supermemory MCP ${response.status}: ${text.slice(0, 200) || 'request failed'}`,
    );
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  if (!body.trim()) return;

  if (contentType.includes('text/event-stream')) {
    emitSseData(body);
  } else {
    process.stdout.write(`${body.trim()}\n`);
  }
}

async function main() {
  const cwd = process.cwd();
  let repoContainerTag = null;
  try {
    repoContainerTag = getContainerTag(cwd);
  } catch {
    repoContainerTag = null;
  }

  let queue = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    queue = queue.then(async () => {
      try {
        // Re-read on every message: the SessionStart hook may finish login
        // after this process starts, and OAuth tokens expire during sessions.
        const apiKey = await getAuthToken(cwd);
        const mcpUrl = getMcpUrl(cwd);
        injectRepoContainerTag(message, repoContainerTag);
        await forward(message, apiKey, mcpUrl);
      } catch (err) {
        if (err.code === 'AUTH_REQUIRED') {
          sessionId = null;
          sendError(
            message.id,
            -32001,
            `Supermemory is not authenticated. Run ${LOGIN_COMMAND} or start a new Muse Code session to log in, or write {"apiKey":"sm_..."} to ${credentialsFile()}.`,
          );
          return;
        }
        sendError(message.id, -32000, `Supermemory MCP proxy error: ${err.message}`);
      }
    });
  });

  rl.on('close', () => {
    // Let a refresh that is still rotating tokens save them before exiting.
    queue.then(settleAuth).then(() => process.exit(0));
  });
}

module.exports = { injectRepoContainerTag };

if (require.main === module) {
  main();
}
