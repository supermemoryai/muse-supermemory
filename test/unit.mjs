import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

describe('session scope', () => {
  const { isHeadless } = require(join(root, 'hooks/lib/session-scope.js'));

  test('only `muse exec` counts as headless', () => {
    assert.equal(isHeadless(['/usr/local/bin/muse-bin-1.4.14', 'exec', 'fix it']), true);
    assert.equal(isHeadless(['/usr/local/bin/muse-bin-1.4.14', '--provider', 'echo']), false);
    assert.equal(isHeadless(['/usr/local/bin/muse-bin-1.4.14', 'serve']), false);
    assert.equal(isHeadless([]), false);
  });

  async function hookRequests(script, input, env) {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"doc_1","profile":{"static":[],"dynamic":[]}}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const home = mkdtempSync(join(tmpdir(), 'muse-sm-home-'));
    try {
      const child = spawn('node', [join(root, 'hooks', script)], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          SUPERMEMORY_MUSE_HOME: home,
          SUPERMEMORY_API_KEY: 'sm_test',
          SUPERMEMORY_API_URL: `http://127.0.0.1:${server.address().port}`,
          ...env,
        },
      });
      child.stdin.end(JSON.stringify(input));
      child.stdout.resume();
      child.stderr.resume();
      const code = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(code, 0);
      return requests;
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }

  const subagent = { MUSE_SESSION_ID: 'top-level', MUSE_THREAD_ID: 'child' };
  const prompt = {
    prompt: 'how do we deploy this service again?',
    session_id: 'child',
    cwd: process.cwd(),
  };

  test('subagent hooks make no Supermemory calls', async () => {
    assert.deepEqual(await hookRequests('session-start.js', prompt, subagent), []);
    assert.deepEqual(await hookRequests('recall.js', prompt, subagent), []);
  });

  test('SUPERMEMORY_CAPTURE_SUBAGENTS=true restores subagent recall', async () => {
    const requests = await hookRequests('recall.js', prompt, {
      ...subagent,
      SUPERMEMORY_CAPTURE_SUBAGENTS: 'true',
    });
    assert.deepEqual(requests, ['POST /v4/profile']);
  });

  test('top-level chats still recall', async () => {
    const requests = await hookRequests('recall.js', prompt, {
      MUSE_SESSION_ID: 'top-level',
      MUSE_THREAD_ID: 'top-level',
    });
    assert.deepEqual(requests, ['POST /v4/profile']);
  });
});
