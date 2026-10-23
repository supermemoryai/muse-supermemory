const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  settingsDir,
  credentialsFile,
  oauthClientFile,
  authLockFile,
  claudeCredentialsFile,
} = require('./paths');

const authSuccessHtml = fs.readFileSync(
  path.join(__dirname, '../templates/auth-success.html'),
  'utf-8',
);
const authErrorHtml = fs.readFileSync(
  path.join(__dirname, '../templates/auth-error.html'),
  'utf-8',
);
// The browser only ever sees these fixed strings; error details stay in the
// terminal so a response body can never leak into the page.
function renderAuthError(error) {
  const denied = error?.code === 'access_denied';
  return authErrorHtml
    .replace('{{title}}', denied ? 'Authorization Denied' : 'Connection Failed')
    .replace(
      '{{message}}',
      denied
        ? 'You declined access, so Supermemory was not connected. Return to Muse Code and log in again to retry.'
        : 'Supermemory could not finish signing you in. Return to Muse Code and log in again.',
    );
}

const AUTH_PORT = 19881;
const AUTH_TIMEOUT = 25000;
const REFRESH_TIMEOUT = 3000;
const REFRESH_REQUEST_TIMEOUT = 10000;
const REFRESH_SKEW = 60000;
const REDIRECT_URI = `http://127.0.0.1:${AUTH_PORT}/callback`;
const SCOPE = 'openid profile email offline_access';
const LOGIN_COMMAND = `node "${path.join(__dirname, 'auth.js')}" login`;

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err) => {
      err ? reject(err) : resolve();
    });
  });
}

async function openUrl(url) {
  const target = url.toString();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('Refusing to open non-http URL');
  }
  if (process.platform === 'win32') {
    try {
      await execFileAsync('rundll32.exe', [
        'url.dll,FileProtocolHandler',
        target,
      ]);
      return;
    } catch {}
    await execFileAsync('cmd.exe', ['/c', 'start', '""', target]);
    return;
  }
  if (process.platform === 'darwin') {
    await execFileAsync('open', [target]);
    return;
  }
  await execFileAsync('xdg-open', [target]);
}

function ensureDir() {
  const dir = settingsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? data
      : null;
  } catch {
    return null;
  }
}

// Muse's own file may hold OAuth tokens or a legacy API key. The Claude Code
// plugin's file is only a fallback for a legacy API key: its OAuth tokens
// belong to a different client and refresh lock, so they are never used here.
function loadCredentials() {
  const own = readJson(credentialsFile());
  if (own?.type === 'oauth' || own?.apiKey) return own;
  const claude = readJson(claudeCredentialsFile());
  if (claude && claude.type === undefined && claude.apiKey) {
    return { apiKey: claude.apiKey, savedAt: claude.savedAt };
  }
  return null;
}

function writeJson(file, data) {
  ensureDir();
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function saveCredentials(credentials) {
  writeJson(credentialsFile(), {
    ...(typeof credentials === 'string'
      ? { apiKey: credentials }
      : credentials),
    savedAt: new Date().toISOString(),
  });
}

// Hooks and the MCP proxy are separate processes. Serialize refresh token
// rotation and re-read credentials under the lock before spending a
// single-use token.
function recoverAbandonedLock() {
  const lockFile = authLockFile();
  let recovery;
  let linked = false;
  try {
    const original = fs.statSync(lockFile);
    // Only one process may reclaim a particular inode. Re-check the inode after
    // linking: another process may already have replaced the abandoned lock.
    recovery = `${lockFile}.${original.dev}.${original.ino}.recovery`;
    fs.linkSync(lockFile, recovery);
    linked = true;
    const snapshot = fs.statSync(recovery);
    if (snapshot.ino !== original.ino || snapshot.dev !== original.dev) return;
    const owner = readJson(recovery);
    let abandoned = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        abandoned = error.code === 'ESRCH';
      }
    } else {
      abandoned = Date.now() - snapshot.mtimeMs > AUTH_TIMEOUT * 2;
    }
    if (abandoned) {
      const current = fs.statSync(lockFile);
      if (current.ino === original.ino && current.dev === original.dev) {
        fs.unlinkSync(lockFile);
      }
    }
  } catch (error) {
    if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
  } finally {
    if (linked) fs.rmSync(recovery, { force: true });
  }
}

async function withAuthLock(action, timeoutMs) {
  ensureDir();
  const lockFile = authLockFile();
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      recoverAbandonedLock();
      if (Date.now() >= deadline)
        throw new Error('Supermemory authentication is busy. Try again.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    return await action(Math.max(1, deadline - Date.now()));
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockFile, { force: true });
  }
}

function secureUrl(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error(
      'OAuth requires HTTPS (HTTP is allowed only for loopback development).',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function getOAuthConfig(baseUrl, mcpUrl) {
  const apiBaseUrl = secureUrl(baseUrl);
  const issuer = secureUrl(
    process.env.SUPERMEMORY_OAUTH_ISSUER || `${apiBaseUrl}/api/auth`,
  );
  return { apiBaseUrl, issuer, resource: secureUrl(mcpUrl) };
}

function sameConfig(credentials, config) {
  return ['apiBaseUrl', 'issuer', 'resource'].every(
    (key) => credentials?.[key] === config[key],
  );
}

function issuerEndpoint(value, issuer) {
  const endpoint = secureUrl(value);
  if (new URL(endpoint).origin !== new URL(issuer).origin) {
    throw new Error('OAuth endpoint does not belong to the configured issuer.');
  }
  return endpoint;
}

// RFC 8414: the well-known segment goes between the origin and the issuer path.
function discoveryUrl(issuer) {
  const url = new URL(issuer);
  return new URL(
    `/.well-known/oauth-authorization-server${url.pathname.replace(/\/+$/, '')}`,
    url.origin,
  );
}

async function oauthRequest(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error' });
  const body = await response.json().catch(() => null);
  const data = body && typeof body === 'object' ? body : {};
  if (!response.ok) {
    // Never include response bodies or tokens in hook output.
    const code = ['invalid_grant', 'invalid_client', 'access_denied'].includes(
      data.error,
    )
      ? data.error
      : 'oauth_request_failed';
    throw Object.assign(
      new Error(
        `Supermemory authorization failed (${code}, HTTP ${response.status}).`,
      ),
      { code, status: response.status },
    );
  }
  return data;
}

async function registerClient(config, signal) {
  const clientFile = oauthClientFile();
  const saved = readJson(clientFile);
  if (
    sameConfig(saved, config) &&
    saved.clientId &&
    saved.redirectUri === REDIRECT_URI
  )
    return saved;
  const metadata = await oauthRequest(discoveryUrl(config.issuer), { signal });
  if (metadata.issuer !== config.issuer)
    throw new Error('OAuth discovery returned an unexpected issuer.');
  const authorizationEndpoint = issuerEndpoint(
    metadata.authorization_endpoint,
    config.issuer,
  );
  const tokenEndpoint = issuerEndpoint(metadata.token_endpoint, config.issuer);
  const registrationEndpoint = issuerEndpoint(
    metadata.registration_endpoint,
    config.issuer,
  );
  const revocationEndpoint = issuerEndpoint(
    metadata.revocation_endpoint,
    config.issuer,
  );
  const registration = await oauthRequest(registrationEndpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Supermemory for Muse Code',
      client_uri: 'https://github.com/supermemoryai/muse-supermemory',
      software_id: 'muse-supermemory',
      software_version: require('../../.muse-plugin/plugin.json').version,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    }),
  });
  if (
    typeof registration.client_id !== 'string' ||
    !registration.client_id ||
    registration.token_endpoint_auth_method !== 'none'
  ) {
    throw new Error('OAuth registration did not return a public client.');
  }
  const client = {
    ...config,
    clientId: registration.client_id,
    redirectUri: REDIRECT_URI,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
  };
  signal.throwIfAborted();
  writeJson(clientFile, client);
  return client;
}

async function exchangeToken(client, parameters, signal, previous) {
  const data = await oauthRequest(
    issuerEndpoint(client.tokenEndpoint, client.issuer),
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        resource: client.resource,
        ...parameters,
      }),
    },
  );
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (
    typeof data.access_token !== 'string' ||
    !data.access_token ||
    typeof data.token_type !== 'string' ||
    data.token_type.toLowerCase() !== 'bearer' ||
    typeof data.expires_in !== 'number' ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    typeof refreshToken !== 'string' ||
    !refreshToken
  ) {
    throw new Error('OAuth returned an invalid token response.');
  }
  signal.throwIfAborted();
  saveCredentials({
    type: 'oauth',
    apiBaseUrl: client.apiBaseUrl,
    issuer: client.issuer,
    resource: client.resource,
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    authorizationEndpoint: client.authorizationEndpoint,
    tokenEndpoint: client.tokenEndpoint,
    revocationEndpoint: client.revocationEndpoint,
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

function authRequired() {
  return Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
}

function ownOAuthCredentials(config) {
  const credentials = readJson(credentialsFile());
  return credentials?.type === 'oauth' && sameConfig(credentials, config)
    ? credentials
    : null;
}

// Rotates the refresh token. The request always runs to completion and saves
// the replacement, whatever the caller's deadline: aborting it mid-flight would
// leave the server holding a rotated refresh token we never stored, and the
// next refresh would fail with invalid_grant and sign the user out.
let pendingRefresh = null;

function refreshCredentials(config) {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = withAuthLock(async (remaining) => {
    const credentials = ownOAuthCredentials(config);
    if (!credentials) throw authRequired();
    if (
      credentials.accessToken &&
      credentials.expiresAt > Date.now() + REFRESH_SKEW
    )
      return credentials.accessToken;
    if (!credentials.refreshToken) throw authRequired();
    try {
      return await exchangeToken(
        credentials,
        {
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
        },
        AbortSignal.timeout(remaining),
        credentials,
      );
    } catch (error) {
      if (error.code === 'invalid_grant' || error.code === 'invalid_client') {
        const registration = { ...credentials };
        delete registration.accessToken;
        delete registration.refreshToken;
        saveCredentials(registration);
        if (error.code === 'invalid_client')
          fs.rmSync(oauthClientFile(), { force: true });
        throw authRequired();
      }
      throw error;
    }
  }, REFRESH_REQUEST_TIMEOUT).finally(() => {
    pendingRefresh = null;
  });
  // Callers may stop waiting before the refresh settles.
  pendingRefresh.catch(() => {});
  return pendingRefresh;
}

// Bounds only how long the caller waits; the refresh itself keeps running.
function waitFor(promise, timeoutMs) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(
          new Error('Supermemory token refresh is still in progress.'),
          { code: 'AUTH_PENDING', name: 'TimeoutError' },
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function getAccessToken(config, timeoutMs = REFRESH_TIMEOUT) {
  const saved = ownOAuthCredentials(config);
  if (!saved) throw authRequired();
  if (saved.accessToken && saved.expiresAt > Date.now() + REFRESH_SKEW)
    return saved.accessToken;
  return waitFor(refreshCredentials(config), timeoutMs);
}

// Resolves once any in-flight refresh has saved or failed, so a process that
// exits explicitly can let the rotated tokens land first.
async function settleAuth() {
  while (pendingRefresh) {
    await pendingRefresh.catch(() => {});
  }
}

// Removes only Muse's credentials; the Claude Code plugin's file is untouched.
async function clearCredentials() {
  return withAuthLock(async (remaining) => {
    const credentials = readJson(credentialsFile());
    if (credentials?.type === 'oauth' && credentials.refreshToken) {
      await oauthRequest(
        issuerEndpoint(credentials.revocationEndpoint, credentials.issuer),
        {
          method: 'POST',
          signal: AbortSignal.timeout(remaining),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: credentials.clientId,
            token: credentials.refreshToken,
            token_type_hint: 'refresh_token',
          }),
        },
      );
    }
    fs.rmSync(credentialsFile(), { force: true });
  }, REFRESH_TIMEOUT);
}

async function startAuthFlow(
  config,
  { force = false, timeoutMs = AUTH_TIMEOUT } = {},
) {
  return withAuthLock(async (remaining) => {
    const current = ownOAuthCredentials(config);
    if (
      !force &&
      current?.accessToken &&
      current.expiresAt > Date.now() + REFRESH_SKEW
    )
      return current.accessToken;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('AUTH_TIMEOUT')),
      remaining,
    );
    let server;
    try {
      const client = await registerClient(config, controller.signal);
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const authorizationUrl = new URL(
        issuerEndpoint(client.authorizationEndpoint, client.issuer),
      );
      authorizationUrl.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
        resource: client.resource,
        code_challenge: crypto
          .createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
        state,
        prompt: 'consent',
      }).toString();
      return await new Promise((resolve, reject) => {
        let exchanging = false;
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason),
          { once: true },
        );
        server = http.createServer(async (req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Referrer-Policy', 'no-referrer');
          let url;
          try {
            url = new URL(req.url, REDIRECT_URI);
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (req.method !== 'GET' || url.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
          }
          const receivedState = Buffer.from(
            url.searchParams.get('state') || '',
          );
          if (
            receivedState.length !== state.length ||
            !crypto.timingSafeEqual(receivedState, Buffer.from(state)) ||
            (url.searchParams.has('iss') &&
              url.searchParams.get('iss') !== client.issuer)
          ) {
            res.writeHead(400).end('Invalid authorization state.');
            return;
          }
          if (exchanging) {
            res.writeHead(409).end();
            return;
          }
          exchanging = true;
          try {
            if (url.searchParams.has('error'))
              throw Object.assign(new Error('Authorization was denied.'), {
                code: 'access_denied',
              });
            const code = url.searchParams.get('code');
            if (!code) throw new Error('Authorization code missing.');
            const token = await exchangeToken(
              client,
              {
                grant_type: 'authorization_code',
                code,
                code_verifier: verifier,
                redirect_uri: REDIRECT_URI,
              },
              controller.signal,
            );
            res
              .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              .end(authSuccessHtml, () => resolve(token));
          } catch (error) {
            res
              .writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
              .end(renderAuthError(error));
            if (error.code === 'invalid_client' && !controller.signal.aborted)
              fs.rmSync(oauthClientFile(), { force: true });
            reject(error);
          }
        });
        server.on('error', () =>
          reject(
            new Error(
              'Cannot open the authentication callback port. Retry after other logins finish.',
            ),
          ),
        );
        server.listen(AUTH_PORT, '127.0.0.1', () => {
          openUrl(authorizationUrl).catch(() =>
            reject(
              new Error(
                'Failed to open the browser. Retry login from an interactive terminal.',
              ),
            ),
          );
        });
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      server?.close();
      server?.closeAllConnections();
    }
  }, timeoutMs);
}

module.exports = {
  LOGIN_COMMAND,
  credentialsFile,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  getOAuthConfig,
  getAccessToken,
  settleAuth,
  startAuthFlow,
  openUrl,
};

// Explicit login migrates a saved API key to OAuth. Logout revokes this
// installation's refresh token. Status never prints credentials.
if (require.main === module) {
  (async () => {
    const { getBaseUrl, getMcpUrl } = require('./settings');
    const command = process.argv[2];
    const cwd = process.cwd();
    if (command === 'login') {
      await startAuthFlow(getOAuthConfig(getBaseUrl(cwd), getMcpUrl(cwd)), {
        force: true,
        timeoutMs: 5 * 60 * 1000,
      });
      console.log('Supermemory connected through OAuth.');
    } else if (command === 'logout') {
      await clearCredentials();
      console.log('Supermemory disconnected.');
    } else if (command === 'status') {
      const credentials = loadCredentials();
      console.log(
        JSON.stringify(
          {
            authentication:
              credentials?.type === 'oauth'
                ? 'oauth'
                : credentials?.apiKey
                  ? 'api_key'
                  : 'none',
            clientId:
              credentials?.type === 'oauth' ? credentials.clientId : undefined,
          },
          null,
          2,
        ),
      );
    } else {
      throw new Error('Usage: node auth.js <login|logout|status>');
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
