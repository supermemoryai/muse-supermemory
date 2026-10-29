import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

describe('background login', () => {
  const { getAccessToken, getOAuthConfig, startBackgroundAuth } = require(
    join(root, 'hooks/lib/auth.js'),
  );

  // A fake OAuth server plus a browser opener that records the consent URL.
  async function setup(t) {
    const dir = mkdtempSync(join(tmpdir(), 'muse-sm-'));
    const binDir = join(dir, 'bin');
    const urlFile = join(dir, 'authorize-url');
    mkdirSync(binDir);
    for (const opener of ['open', 'xdg-open']) {
      writeFileSync(
        join(binDir, opener),
        `#!/bin/sh\nprintf '%s' "$1" > "${urlFile}"\n`,
      );
      chmodSync(join(binDir, opener), 0o755);
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url, base);
      const json = (body) =>
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(body));
      if (url.pathname === '/.well-known/oauth-authorization-server/api/auth') {
        json({
          issuer: `${base}/api/auth`,
          authorization_endpoint: `${base}/api/auth/authorize`,
          token_endpoint: `${base}/api/auth/token`,
          registration_endpoint: `${base}/api/auth/register`,
          revocation_endpoint: `${base}/api/auth/revoke`,
        });
      } else if (url.pathname === '/api/auth/register') {
        json({ client_id: 'client-1', token_endpoint_auth_method: 'none' });
      } else if (url.pathname === '/api/auth/authorize') {
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({
          code: 'code-1',
          state: url.searchParams.get('state'),
        }).toString();
        res.writeHead(302, { Location: callback.toString() }).end();
      } else if (url.pathname === '/api/auth/token') {
        json({
          access_token: 'access-1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
        });
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = {
      SUPERMEMORY_MUSE_HOME: process.env.SUPERMEMORY_MUSE_HOME,
      PATH: process.env.PATH,
    };
    process.env.SUPERMEMORY_MUSE_HOME = join(dir, 'home');
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    t.after(() => {
      try {
        process.kill(
          JSON.parse(
            readFileSync(join(dir, 'home', 'auth.lock'), 'utf-8'),
          ).pid,
        );
      } catch {}
      Object.assign(process.env, env);
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { base, urlFile };
  }

  test('keeps listening after the hook stops waiting', async (t) => {
    const { base, urlFile } = await setup(t);
    const config = getOAuthConfig(base, `${base}/mcp`);

    await assert.rejects(startBackgroundAuth(config, 1000), {
      message: 'AUTH_PENDING',
    });
    await assert.rejects(getAccessToken(config), { code: 'AUTH_REQUIRED' });

    const authorize = await fetch(readFileSync(urlFile, 'utf-8'), {
      redirect: 'manual',
    });
    const callback = await fetch(authorize.headers.get('location'));
    assert.equal(callback.status, 200);
    assert.equal(await getAccessToken(config), 'access-1');
  });

  test('reports AUTH_FAILED when the login cannot start', async (t) => {
    await setup(t);
    const config = getOAuthConfig('http://127.0.0.1:9', 'http://127.0.0.1:9/mcp');
    await assert.rejects(startBackgroundAuth(config, 10000), {
      message: 'AUTH_FAILED',
    });
  });
});
