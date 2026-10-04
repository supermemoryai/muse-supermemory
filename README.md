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

The first session opens a browser login and writes `~/.supermemory-muse/credentials.json`.

If you already logged in through the Claude Code plugin, that key is reused from `~/.supermemory-claude/credentials.json`.

Or write the file yourself:

```json
{ "apiKey": "sm_..." }
```

Get a key at [app.supermemory.ai](https://app.supermemory.ai).

## Commands

| Command | Description |
| --- | --- |
| `/supermemory:index` | Index codebase architecture and patterns |
| `/supermemory:status` | Auth, container tag, and API reachability |
| `/supermemory:logout` | Clear saved Muse credentials |

## Configuration

**Global** — `~/.supermemory-muse/settings.json`

```json
{
  "maxProfileItems": 5,
  "debug": false
}
```

| Option | Description |
| --- | --- |
| `baseUrl` | Supermemory API URL for every project, e.g. a self-hosted server |
| `mcpUrl` | MCP endpoint to use when `baseUrl` is not the hosted API |

Muse clears the environment for hooks and the MCP proxy, so set a self-hosted URL here rather than in your shell. The order is `SUPERMEMORY_API_URL`, then the project's `baseUrl` (a committed project config overrides this file), then this one, then `https://api.supermemory.ai`.

With a self-hosted `baseUrl`, the MCP proxy stays off unless `mcpUrl` (or `SUPERMEMORY_MCP_URL`) names an MCP endpoint, and a missing key does not open the hosted browser login: write the server's key to `~/.supermemory-muse/credentials.json`. A key in `~/.supermemory-claude/credentials.json` is also used, so it must belong to the same server.

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
