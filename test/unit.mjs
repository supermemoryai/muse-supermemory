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

  test('PreToolUse allows the snake_case read tools', () => {
    for (const tool of ['get_profile', 'list_documents', 'get_document', 'list_memories', 'list_spaces', 'who_am_i']) {
      const result = spawnSync('node', [join(root, 'hooks/recall-approve.js')], {
        encoding: 'utf8',
        input: JSON.stringify({ tool_name: `mcp__supermemory__${tool}`, tool_input: {} }),
      });
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.equal(out.hookSpecificOutput?.permissionDecision, 'allow', tool);
    }
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
  const { injectRepoContainerTag } = require(join(root, 'mcp/proxy.js'));

  test('defaults add_memory to the repo container', () => {
    const message = {
      method: 'tools/call',
      params: { name: 'add_memory', arguments: { content: 'use bun' } },
    };
    injectRepoContainerTag(message, 'repo_example__abc');
    assert.equal(message.params.arguments.containerTag, 'repo_example__abc');
  });

  test('defaults snake_case read and forget tools to the repo container', () => {
    for (const name of ['list_documents', 'list_memories', 'get_document', 'get_profile', 'forget_memory']) {
      const message = { method: 'tools/call', params: { name, arguments: {} } };
      injectRepoContainerTag(message, 'repo_example__abc');
      assert.equal(message.params.arguments.containerTag, 'repo_example__abc', name);
    }
  });

  test('leaves account-level tools alone', () => {
    for (const name of ['list_spaces', 'who_am_i', 'set-active-tag', 'select-space']) {
      const message = { method: 'tools/call', params: { name, arguments: {} } };
      injectRepoContainerTag(message, 'repo_example__abc');
      assert.deepEqual(message.params.arguments, {}, name);
    }
  });

  test('does not override an explicit namespace', () => {
    const message = {
      method: 'tools/call',
      params: { name: 'list_documents', arguments: { namespace: 'team' } },
    };
    injectRepoContainerTag(message, 'repo_example__abc');
    assert.deepEqual(message.params.arguments, { namespace: 'team' });
  });

  test('does not overwrite an explicit containerTag', () => {
    const message = {
      method: 'tools/call',
      params: {
        name: 'search_memory',
        arguments: { query: 'x', containerTag: 'other' },
      },
    };
    injectRepoContainerTag(message, 'repo_example__abc');
    assert.equal(message.params.arguments.containerTag, 'other');
  });
});
