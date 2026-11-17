import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { readRawDelta } = require(join(root, 'hooks/lib/transcript.js'));

const line = (sequence, payload) =>
  `${JSON.stringify({ sequence, payload_type: 'runtime.session', payload })}\n`;
const prompt = (sequence, text) =>
  line(sequence, { kind: 'run', event: { kind: 'started', prompt: text } });
const reply = (sequence, text) =>
  line(sequence, {
    kind: 'event',
    event: { kind: 'assistant_message_committed', text },
  });

function tempSession(t) {
  const dir = mkdtempSync(join(tmpdir(), 'muse-sm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.SUPERMEMORY_MUSE_HOME = join(dir, 'home');
  return { dir, log: join(dir, 'session.jsonl') };
}

function runHook(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(root, script)], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('transcript', () => {
  test('sends complete new lines and resends until committed', (t) => {
    const { log } = tempSession(t);
    const first = prompt(1, 'use bun not npm') + reply(2, 'Switching to bun.');
    writeFileSync(log, `${first}{"sequence":3,"payl`);

    const delta = readRawDelta(log, 'sess-1');
    assert.equal(delta.raw, first);
    assert.equal(delta.offset, 0);
    assert.equal(delta.generation, 0);
    assert.equal(readRawDelta(log, 'sess-1').raw, first);

    delta.commit();
    assert.equal(readRawDelta(log, 'sess-1'), null);

    const next = prompt(3, 'now add a lockfile');
    writeFileSync(log, first + next);
    const second = readRawDelta(log, 'sess-1');
    assert.equal(second.raw, next);
    assert.equal(second.offset, Buffer.byteLength(first));
    assert.equal(second.generation, 0);
  });

  test('starts a new generation when the transcript is rewritten', (t) => {
    const { log } = tempSession(t);
    writeFileSync(log, prompt(1, 'old prompt') + reply(2, 'old reply'));
    readRawDelta(log, 'sess-2').commit();

    const rewritten = prompt(1, 'new prompt') + reply(2, 'new reply') + prompt(3, 'more');
    writeFileSync(log, rewritten);
    const delta = readRawDelta(log, 'sess-2');
    assert.equal(delta.raw, rewritten);
    assert.equal(delta.offset, 0);
    assert.equal(delta.generation, 1);
    delta.commit();

    const truncated = prompt(1, 'short');
    writeFileSync(log, truncated);
    const after = readRawDelta(log, 'sess-2');
    assert.equal(after.raw, truncated);
    assert.equal(after.offset, 0);
    assert.equal(after.generation, 2);
  });
});

describe('capture', () => {
  test('advances the cursor only after the server accepts the delta', async (t) => {
    const { dir, log } = tempSession(t);
    mkdirSync(join(dir, '.muse'));
    writeFileSync(join(dir, '.muse', 'supermemory.json'),
      JSON.stringify({ namespace: 'repo_test' }));

    const requests = [];
    const statuses = [500, 200, 200];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
        const status = statuses[requests.length - 1];
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { id: 'sess-3', status: 'queued' } : { error: 'boom' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const env = {
      SUPERMEMORY_MUSE_HOME: process.env.SUPERMEMORY_MUSE_HOME,
      SUPERMEMORY_MUSE_API_KEY: 'sm_test_key',
      SUPERMEMORY_API_URL: `http://127.0.0.1:${server.address().port}`,
    };
    const input = { session_id: 'sess-3', transcript_path: log, cwd: dir };
    const first = prompt(1, 'use bun not npm') + reply(2, 'Switching to bun.');
    writeFileSync(log, first);

    assert.equal((await runHook('hooks/capture.js', input, env)).status, 0);
    assert.equal(requests.length, 1);
    assert.equal(readRawDelta(log, 'sess-3').raw, first);

    assert.equal((await runHook('hooks/capture.js', input, env)).status, 0);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.content, first);

    const [, accepted] = requests;
    assert.equal(accepted.url, '/ns/repo_test/document');
    assert.equal(accepted.headers['x-sm-session'], 'muse-code');
    assert.equal(accepted.headers['x-sm-source'], 'muse-code');
    assert.equal(accepted.headers.authorization, 'Bearer sm_test_key');
    assert.equal(accepted.body.id, 'sess-3');
    assert.equal(accepted.body.content, first);
    assert.equal(accepted.body.metadata.sm_source, 'muse-code');
    assert.equal(accepted.body.metadata.sm_session_generation, 0);
    assert.equal(accepted.body.metadata.sm_session_offset, 0);
    assert.equal(accepted.body.taskType, 'memory');
    assert.equal(accepted.body.dreaming, 'dynamic');

    const next = prompt(3, 'now add a lockfile');
    writeFileSync(log, first + next);
    assert.equal((await runHook('hooks/capture.js', input, env)).status, 0);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].body.content, next);
    assert.equal(requests[2].body.metadata.sm_session_offset, Buffer.byteLength(first));
    assert.equal(readRawDelta(log, 'sess-3'), null);
  });
});

describe('hooks', () => {
  test('UserPromptSubmit reads v5 search results', () => {
    const { selectResults } = require(join(root, 'hooks/recall.js'));
    const results = selectResults({ results: [
      { id: 'mem_1', memory: 'Use bun', similarity: 0.9 },
      { id: 'mem_2', memory: 'Outdated', similarity: 0.2 },
    ] });
    assert.deepEqual(results.map((result) => result.id), ['mem_1']);
  });

  test('UserPromptSubmit discovery hint matches proxy scoping', () => {
    const { formatDiscovery } = require(join(root, 'hooks/recall.js'));
    const hint = formatDiscovery('repo_example__abc');
    assert.match(hint, /without a namespace search this project \("repo_example__abc"\)/);
    assert.match(hint, /list_spaces/);
    assert.doesNotMatch(hint, /Omit namespace to search the account/);
  });

  test('SessionStart formats v5 profile fact objects', () => {
    const { formatContext } = require(join(root, 'hooks/session-start.js'));
    const context = formatContext({ profile: {
      static: [{ id: 'mem_1', memory: 'Prefers bun' }],
      dynamic: [{ id: 'mem_2', memory: 'Planning a release' }],
    } }, 5, 'repo_example__abc', 'example');
    assert.match(context, /◪ Prefers bun/);
    assert.match(context, /◪ Planning a release/);
    assert.doesNotMatch(context, /\[object Object\]/);
  });

  test('UserPromptSubmit skips slash commands', () => {
    const result = spawnSync('node', [join(root, 'hooks/recall.js')], {
      encoding: 'utf8',
      input: JSON.stringify({ prompt: '/status', cwd: process.cwd() }),
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(out.continue, true);
    assert.equal(out.suppressOutput, true);
  });

  test('PreToolUse allows supermemory search_memory', () => {
    const result = spawnSync('node', [join(root, 'hooks/recall-approve.js')], {
      encoding: 'utf8',
      input: JSON.stringify({
        tool_name: 'mcp__supermemory__search_memory',
        tool_input: { query: 'auth' },
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  });

  test('PreToolUse does not auto-allow writes', () => {
    const result = spawnSync('node', [join(root, 'hooks/recall-approve.js')], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'mcp__supermemory__add_memory' }),
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(out.continue, true);
  });
});

describe('mcp proxy', () => {
  const { injectRepoNamespace } = require(join(root, 'mcp/proxy.js'));

  test('defaults add_memory to the repo namespace', () => {
    const message = {
      method: 'tools/call',
      params: { name: 'add_memory', arguments: { content: 'use bun' } },
    };
    injectRepoNamespace(message, 'repo_example__abc');
    assert.equal(message.params.arguments.namespace, 'repo_example__abc');
  });

  test('does not overwrite an explicit namespace', () => {
    const message = {
      method: 'tools/call',
      params: {
        name: 'search_memory',
        arguments: { query: 'x', namespace: 'other' },
      },
    };
    injectRepoNamespace(message, 'repo_example__abc');
    assert.equal(message.params.arguments.namespace, 'other');
  });

  test('scopes current read tools', () => {
    const profile = { method: 'tools/call', params: { name: 'get_profile' } };
    injectRepoNamespace(profile, 'repo_example__abc');
    assert.equal(profile.params.arguments.namespace, 'repo_example__abc');

    const search = {
      method: 'tools/call',
      params: { name: 'search_memory', arguments: { query: 'x' } },
    };
    injectRepoNamespace(search, 'repo_example__abc');
    assert.equal(search.params.arguments.namespace, 'repo_example__abc');
  });

  test('preserves an explicit scope from an older MCP call', () => {
    const message = {
      method: 'tools/call',
      params: { name: 'search_memory', arguments: { query: 'x', containerTag: 'other' } },
    };
    injectRepoNamespace(message, 'repo_example__abc');
    assert.equal(message.params.arguments.namespace, undefined);
  });
});

describe('namespace configuration', () => {
  const { getNamespace } = require(join(root, 'hooks/lib/namespace.js'));

  test('uses the project namespace override', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-sm-namespace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, '.muse'));
    writeFileSync(join(dir, '.muse', 'supermemory.json'),
      JSON.stringify({ namespace: 'my_project' }));
    assert.equal(getNamespace(dir), 'my_project');
  });

  test('keeps an existing project scope', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-sm-namespace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, '.muse'));
    writeFileSync(join(dir, '.muse', 'supermemory.json'),
      JSON.stringify({ repoContainerTag: 'old_project' }));
    assert.equal(getNamespace(dir), 'old_project');
  });
});

describe('v5 API', () => {
  const { getProfile, searchMemories, addSession } = require(join(root, 'hooks/lib/api.js'));

  test('uses namespace routes and v5 request bodies', async (t) => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      const result = calls.length === 1
        ? { profile: { static: [], dynamic: [], buckets: {} } }
        : calls.length === 2
          ? { results: [], total: 0, searchTime: 0 }
          : { id: 'doc_1', status: 'queued' };
      return { ok: true, json: async () => result };
    };
    t.after(() => { global.fetch = originalFetch; });

    await getProfile('https://api.supermemory.ai', 'key', 'repo:alpha');
    await searchMemories('https://api.supermemory.ai', 'key', 'repo:alpha', 'build decision');
    await addSession('https://api.supermemory.ai', 'key', '{"sequence":1}\n', 'repo:alpha',
      { type: 'session_turn' },
      { id: 'session-1', generation: 2, offset: 40, supportingContext: 'agent context' });

    assert.deepEqual(calls.map(({ url }) => url), [
      'https://api.supermemory.ai/ns/repo%3Aalpha/profile',
      'https://api.supermemory.ai/ns/repo%3Aalpha/search',
      'https://api.supermemory.ai/ns/repo%3Aalpha/document',
    ]);
    assert.deepEqual(calls[0].body, {});
    assert.equal(calls[1].body.query, 'build decision');
    assert.equal(calls[1].body.searchMode, 'memories');
    assert.equal(calls[1].headers['x-sm-session'], undefined);
    assert.equal(calls[2].headers['x-sm-session'], 'muse-code');
    assert.equal(calls[2].body.id, 'session-1');
    assert.equal(calls[2].body.content, '{"sequence":1}\n');
    assert.deepEqual(calls[2].body.metadata, {
      sm_source: 'muse-code',
      type: 'session_turn',
      sm_session_generation: 2,
      sm_session_offset: 40,
    });
    assert.equal(calls[2].body.supportingContext, 'agent context');
    assert.equal(calls[2].body.taskType, 'memory');
    assert.equal(calls[2].body.dreaming, 'dynamic');
    assert.deepEqual(Object.keys(calls[2].body).sort(), [
      'content', 'dreaming', 'id', 'metadata', 'supportingContext', 'taskType',
    ]);
  });

  test('does not accept a failed document response', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ id: 'doc_1', status: 'failed' }) });
    t.after(() => { global.fetch = originalFetch; });
    await assert.rejects(
      addSession('https://api.supermemory.ai', 'key', '{"sequence":1}\n', 'repo_alpha', {}),
      /did not confirm document acceptance/,
    );
  });
});
