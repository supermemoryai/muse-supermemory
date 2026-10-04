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

describe('global baseUrl', () => {
  const settingsPath = join(root, 'hooks/lib/settings.js');

  function freshSettings() {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(join('hooks', 'lib'))) delete require.cache[key];
    }
    return require(settingsPath);
  }

  function withHome(t, settings) {
    const dir = mkdtempSync(join(tmpdir(), 'muse-sm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    if (settings) {
      const text = typeof settings === 'string' ? settings : JSON.stringify(settings);
      writeFileSync(join(home, 'settings.json'), text);
    }
    const cwd = join(dir, 'work');
    mkdirSync(cwd, { recursive: true });
    const saved = {
      SUPERMEMORY_MUSE_HOME: process.env.SUPERMEMORY_MUSE_HOME,
      SUPERMEMORY_API_URL: process.env.SUPERMEMORY_API_URL,
    };
    process.env.SUPERMEMORY_MUSE_HOME = home;
    delete process.env.SUPERMEMORY_API_URL;
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    return { dir, home, cwd };
  }

  test('falls back to the hosted API with no settings', (t) => {
    const { cwd } = withHome(t, null);
    assert.equal(freshSettings().getBaseUrl(cwd), 'https://api.supermemory.ai');
  });

  test('uses baseUrl from ~/.supermemory-muse/settings.json', (t) => {
    const { cwd } = withHome(t, { baseUrl: 'https://sm.example.internal:6767' });
    assert.equal(freshSettings().getBaseUrl(cwd), 'https://sm.example.internal:6767');
  });

  test('project baseUrl and env still win over the global one', (t) => {
    const { cwd } = withHome(t, { baseUrl: 'https://global.example' });
    mkdirSync(join(cwd, '.muse'), { recursive: true });
    writeFileSync(
      join(cwd, '.muse', 'supermemory.json'),
      JSON.stringify({ baseUrl: 'https://project.example' }),
    );
    assert.equal(freshSettings().getBaseUrl(cwd), 'https://project.example');
    process.env.SUPERMEMORY_API_URL = 'https://env.example';
    assert.equal(freshSettings().getBaseUrl(cwd), 'https://env.example');
  });

  test('a settings.json that sets baseUrl but does not parse is an error', (t) => {
    const { cwd } = withHome(t, '{ "baseUrl": "https://sm.example.internal:6767", }');
    assert.throws(() => freshSettings().getBaseUrl(cwd), /Invalid .*settings\.json/);
  });

  test('a broken settings.json without baseUrl still uses the hosted API', (t) => {
    const { cwd } = withHome(t, '{ "debug": true, }');
    assert.equal(freshSettings().getBaseUrl(cwd), 'https://api.supermemory.ai');
  });

  test('a byte order mark in settings.json is ignored', (t) => {
    const { cwd } = withHome(t, '\uFEFF{ "baseUrl": "https://sm.example.internal:6767" }');
    assert.equal(freshSettings().getBaseUrl(cwd), 'https://sm.example.internal:6767');
  });

  test('other spellings of the hosted API are not treated as self-hosted', () => {
    const { isCustomBaseUrl } = freshSettings();
    assert.equal(isCustomBaseUrl('https://api.supermemory.ai/'), false);
    assert.equal(isCustomBaseUrl('https://API.supermemory.ai'), false);
    assert.equal(isCustomBaseUrl('https://api.supermemory.ai:443'), false);
    assert.equal(isCustomBaseUrl('https://sm.example.internal:6767'), true);
  });

  function runIsolated(t, script, input, settings, envOverrides = {}, timeout) {
    const { dir, home, cwd } = withHome(t, settings);
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SUPERMEMORY_MUSE_HOME: home,
      HOME: dir,
      USERPROFILE: dir,
      SUPERMEMORY_MUSE_API_KEY: 'sm_test_dummy',
      ...envOverrides,
    };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    return spawnSync(
      'node',
      ['--require', join(root, 'test/no-network.cjs'), join(root, script)],
      { encoding: 'utf8', input, env, cwd, timeout },
    );
  }

  const initialize = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`;

  function lastMessage(result) {
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  }

  test('MCP proxy does not forward a self-hosted key to the hosted MCP', (t) => {
    const result = runIsolated(t, 'mcp/proxy.js', initialize, {
      baseUrl: 'https://sm.example.internal:6767',
    });
    const out = lastMessage(result);
    assert.equal(out.error.code, -32002, result.stdout + result.stderr);
    assert.match(out.error.message, /self-hosted/);
  });

  test('MCP proxy stays off when settings.json is broken', (t) => {
    const result = runIsolated(
      t,
      'mcp/proxy.js',
      initialize,
      '{ "baseUrl": "https://sm.example.internal:6767", }',
    );
    const out = lastMessage(result);
    assert.equal(out.error.code, -32002, result.stdout + result.stderr);
    assert.match(out.error.message, /Invalid .*settings\.json/);
  });

  test('MCP proxy uses mcpUrl with a self-hosted baseUrl', (t) => {
    const result = runIsolated(t, 'mcp/proxy.js', initialize, {
      baseUrl: 'https://sm.example.internal:6767',
      mcpUrl: 'https://sm.example.internal:6767/mcp',
    });
    assert.match(lastMessage(result).error.message, /sm\.example\.internal:6767\/mcp/);
  });

  test('MCP proxy still uses the hosted MCP without a baseUrl', (t) => {
    const result = runIsolated(t, 'mcp/proxy.js', initialize, null);
    assert.match(lastMessage(result).error.message, /mcp\.supermemory\.ai\/mcp/);
  });

  test('SessionStart with a self-hosted URL and no key does not open the hosted login', (t) => {
    const result = runIsolated(
      t,
      'hooks/session-start.js',
      '{}',
      { baseUrl: 'https://sm.example.internal:6767' },
      { SUPERMEMORY_MUSE_API_KEY: undefined },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No API key for https:\/\/sm\.example\.internal:6767/);
    assert.doesNotMatch(result.stderr, /browser launch disabled/);
  });

  test('SessionStart with no baseUrl and no key still starts the hosted login', (t) => {
    // The login waits 25 s for a browser callback; the launch happens first.
    const result = runIsolated(
      t,
      'hooks/session-start.js',
      '{}',
      null,
      { SUPERMEMORY_MUSE_API_KEY: undefined },
      5000,
    );
    assert.match(result.stderr, /browser launch disabled/);
  });
});
