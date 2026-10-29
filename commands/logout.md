---
description: Clear saved Supermemory credentials for Muse Code
---

Log the user out of Supermemory for Muse Code.

1. Locate this plugin's `hooks/lib/auth.js` (in the installed supermemory plugin directory, next to `.muse-plugin/plugin.json`) and run `node <path-to>/hooks/lib/auth.js logout`. It revokes the OAuth refresh token and removes `~/.supermemory-muse/credentials.json`. Never print the file's contents or any token.
2. If the script cannot be found, delete `~/.supermemory-muse/credentials.json` instead.

Do not delete `~/.supermemory-claude/credentials.json` unless the user explicitly asks to log out of Claude Code too.

Confirm the file is gone and tell the user the next Muse session will open the browser login again (if `~/.supermemory-claude/credentials.json` holds a legacy API key, that key is reused instead).
