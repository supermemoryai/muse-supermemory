const AGENT_SUPPORTING_CONTEXT = `Shared coding-agent memory for one software repository.

RULES:
- Try to remember things that a human would remember — a teammate recalls decisions and lessons, not what state the working tree was in
- Preserve durable context that helps a coding agent continue the work
- Condense assistant responses into decisions, outcomes, and reusable knowledge
- Keep user preferences and project facts concise and independently understandable

EXTRACT:
- User preferences, accepted decisions, durable workflows, actions, and learnings
- Architecture, conventions, patterns, setup, and decisions

SKIP:
- Transient repo state git already tracks
- Generic assistant suggestions the user did not accept
- Transient command output and low-value implementation chatter`;

const REQUEST_TIMEOUT_MS = 3000;
const SOURCE = 'muse-code';

async function post(baseUrl, apiKey, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-sm-source': SOURCE,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(
      new Error(`Supermemory API ${response.status}: ${text.slice(0, 200)}`),
      { status: response.status },
    );
  }
  return response.json();
}

function namespacePath(namespace, resource) {
  if (typeof namespace !== 'string' || !/^[a-zA-Z0-9_:-]{1,100}$/.test(namespace)) {
    throw new Error('Invalid Supermemory namespace: expected 1–100 letters, digits, underscores, hyphens, or colons');
  }
  return `/ns/${encodeURIComponent(namespace)}/${resource}`;
}

async function getProfile(baseUrl, apiKey, namespace, options = {}) {
  const result = await post(baseUrl, apiKey, namespacePath(namespace, 'profile'), {}, options.timeoutMs);
  if (!Array.isArray(result?.profile?.static) || !Array.isArray(result?.profile?.dynamic)) {
    throw new Error('Supermemory returned an invalid profile response');
  }
  return result;
}

async function searchMemories(baseUrl, apiKey, namespace, query, options = {}) {
  const result = await post(baseUrl, apiKey, namespacePath(namespace, 'search'), {
    query,
    searchMode: 'memories',
    threshold: 0.55,
    rewriteQuery: false,
    limit: 10,
  }, options.timeoutMs);
  if (!Array.isArray(result?.results)) {
    throw new Error('Supermemory returned an invalid search response');
  }
  return result;
}

async function addMemory(baseUrl, apiKey, content, namespace, metadata, options = {}) {
  const body = {
    content,
    metadata: { sm_source: SOURCE, ...metadata },
    taskType: 'memory',
    dreaming: 'dynamic',
  };
  if (options.id) body.id = options.id;
  if (options.supportingContext) body.supportingContext = options.supportingContext;
  const result = await post(baseUrl, apiKey, namespacePath(namespace, 'document'), body, options.timeoutMs);
  const accepted = ['unknown', 'queued', 'extracting', 'chunking', 'embedding', 'indexing', 'done'];
  if (typeof result?.id !== 'string' || !result.id.trim() || !accepted.includes(result.status)) {
    throw new Error('Supermemory did not confirm document acceptance');
  }
  return result;
}

module.exports = { AGENT_SUPPORTING_CONTEXT, getProfile, searchMemories, addMemory };
