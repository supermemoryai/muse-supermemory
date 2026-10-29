---
description: Show Supermemory authentication and connection status
---

Report the user's Supermemory status for this Muse Code session.

1. Determine the credential source. Env `SUPERMEMORY_MUSE_API_KEY` / `SUPERMEMORY_API_KEY` / `SUPERMEMORY_CC_API_KEY` and a project `apiKey` take precedence. Otherwise run `node <path-to>/hooks/lib/auth.js status` from this plugin's directory (next to `.muse-plugin/plugin.json`); it prints only the auth type (`oauth`, `api_key` or `none`) and the OAuth client ID. If you read `~/.supermemory-muse/credentials.json` yourself, never print `accessToken`, `refreshToken` or a full API key — show at most the first 6 and last 4 characters of an API key. A legacy `{"apiKey":...}` in `~/.supermemory-claude/credentials.json` is used as a fallback; OAuth tokens in that file belong to Claude Code and are never used.
2. For an API key, probe real connectivity with it (skip this for OAuth; the MCP check below covers it):

```
curl -sS -o /dev/null -w '%{http_code}' -m 8 -X POST "${SUPERMEMORY_API_URL:-https://api.supermemory.ai}/v4/profile" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "x-sm-source: muse-code" \
  -d '{"containerTag":"<this project's container tag>","q":"connectivity probe"}'
```

Interpret loudly: `200` → reachable and the key works; `401`/`403` → reachable but the key is invalid or revoked; timeout / connection error / `5xx` → API unreachable.

3. Call the `whoAmI` MCP tool if the supermemory MCP server is connected.
4. Report: authenticated or not, key source, the active project container tag, API reachability, and MCP reachability.

If not authenticated, tell the user to run `node <path-to>/hooks/lib/auth.js login` (or start a new session, which opens the browser login automatically), or to write `{"apiKey":"sm_..."}` to `~/.supermemory-muse/credentials.json`.
