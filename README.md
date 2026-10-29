# muse-supermemory

Persistent memory for [Muse Code](https://dev.meta.ai/docs/muse-code) — powered by [Supermemory](https://supermemory.ai).

Your agent remembers what you worked on across sessions and projects.

Docs: [Muse Code plugin](https://supermemory.ai/docs/integrations/muse-code)

## Install

Muse Code 1.3+ with plugins enabled. In a Muse session:

```
/plugins
```

Or from the CLI:

```bash
export MUSE_EXPERIMENTAL_PLUGINS=1
muse plugins marketplace add supermemory https://github.com/supermemoryai/muse-supermemory
muse plugins install supermemory@supermemory
muse plugins approve supermemory
```

Local bundle (this repo):

```bash
export MUSE_EXPERIMENTAL_PLUGINS=1
muse plugins install . --scope user
muse plugins approve supermemory
```

Requires Node.js 18+ on your PATH — hooks and the MCP proxy run as Node scripts.

## What it does

- **Session start** — injects the project profile and recent memories
- **Prompt recall** — searches supermemory against each substantive prompt
- **Auto capture** — saves the turn when the session stops
- **MCP tools** — search / save / list memories on demand
- **Read-only auto-approve** — recall tool calls skip the permission prompt

Muse runs hooks with a cleared environment, so the API key is read from a file, not from the shell.

## Auth

The first session opens a browser login (OAuth with PKCE) and writes `~/.supermemory-muse/credentials.json`. Tokens refresh automatically.

Log in, out, or check status explicitly from the plugin directory:

```bash
node hooks/lib/auth.js login    # also migrates a saved API key to OAuth
node hooks/lib/auth.js logout   # revokes the token, removes Muse credentials only
node hooks/lib/auth.js status
```

For a custom backend set `baseUrl` (project config) or `SUPERMEMORY_API_URL`; when that host does not start with `api.`, also set `SUPERMEMORY_MCP_URL`.

A legacy API key saved by the Claude Code plugin in `~/.supermemory-claude/credentials.json` is still reused. Claude Code's OAuth tokens are not shared.

Or use an API key: write the file yourself:

```json
{ "apiKey": "sm_..." }
```

Get a key at [app.supermemory.ai](https://app.supermemory.ai).

## Commands

| Command | Description |
| --- | --- |
| `/supermemory:index` | Index codebase architecture and patterns |
| `/supermemory:status` | Auth, container tag, and API reachability |
| `/supermemory:logout` | Revoke and clear saved Muse credentials |

## Configuration

**Global** — `~/.supermemory-muse/settings.json`

```json
{
  "maxProfileItems": 5,
  "debug": false
}
```

**Project** — `.muse/supermemory.json`

```json
{
  "apiKey": "sm_...",
  "baseUrl": "https://api.supermemory.ai",
  "repoContainerTag": "my-team-project"
}
```

A Claude Code project config at `.claude/.supermemory-claude/config.json` is also honored, so the same repo keeps one container tag across tools.

| Option | Description |
| --- | --- |
| `apiKey` | Project-specific API key |
| `baseUrl` | Supermemory API URL |
| `repoContainerTag` | Override the auto-derived team/project container |

## License

MIT
