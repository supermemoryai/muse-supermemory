import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  formatNewEntries,
  setLastCapturedSequence,
} = require(join(root, 'hooks/lib/transcript.js'));

describe('transcript', () => {
  test('extracts user prompts and assistant messages from Muse session.jsonl', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-sm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, 'session.jsonl');
    const records = [
      {
        sequence: 1,
        payload_type: 'runtime.session',
        payload: {
          kind: 'run',
          event: { kind: 'started', prompt: 'use bun not npm' },
        },
      },
      {
        sequence: 2,
        payload_type: 'runtime.session',
        payload: {
          kind: 'event',
          event: {
            kind: 'assistant_message_committed',
            text: 'Switching the install path to bun.',
          },
        },
      },
      {
        sequence: 3,
        payload_type: 'runtime.session',
        payload: {
          kind: 'event',
          event: { kind: 'assistant_tool_calls_committed', tool_calls: [] },
        },
      },
    ];
    writeFileSync(log, records.map((r) => JSON.stringify(r)).join('\n'));
    const delta = formatNewEntries(log, 'sess-1');
    assert.match(delta.formatted, /use bun not npm/);
    assert.match(delta.formatted, /Switching the install path to bun/);
    assert.equal(delta.lastSequence, 3);
  });

  test('skips already captured sequences', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-sm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.SUPERMEMORY_MUSE_HOME = join(dir, 'home');
    mkdirSync(process.env.SUPERMEMORY_MUSE_HOME, { recursive: true });
    const log = join(dir, 'session.jsonl');
    writeFileSync(
      log,
      [
        JSON.stringify({
          sequence: 1,
          payload: { kind: 'run', event: { kind: 'started', prompt: 'old' } },
        }),
        JSON.stringify({
          sequence: 2,
          payload: { kind: 'run', event: { kind: 'started', prompt: 'new' } },
        }),
      ].join('\n'),
    );
    setLastCapturedSequence('sess-2', 1);
    const delta = formatNewEntries(log, 'sess-2');
    assert.match(delta.formatted, /new/);
    assert.doesNotMatch(delta.formatted, /old/);
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
  const { getProfile, searchMemories, addMemory } = require(join(root, 'hooks/lib/api.js'));

  test('uses namespace routes and v5 request bodies', async (t) => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
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
    await addMemory('https://api.supermemory.ai', 'key', 'session text', 'repo:alpha',
      { type: 'session_turn' }, { id: 'session-1', supportingContext: 'agent context' });

    assert.deepEqual(calls.map(({ url }) => url), [
      'https://api.supermemory.ai/ns/repo%3Aalpha/profile',
      'https://api.supermemory.ai/ns/repo%3Aalpha/search',
      'https://api.supermemory.ai/ns/repo%3Aalpha/document',
    ]);
    assert.deepEqual(calls[0].body, {});
    assert.equal(calls[1].body.query, 'build decision');
    assert.equal(calls[1].body.searchMode, 'memories');
    assert.equal(calls[2].body.id, 'session-1');
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
      addMemory('https://api.supermemory.ai', 'key', 'session text', 'repo_alpha', {}),
      /did not confirm document acceptance/,
    );
  });
});
