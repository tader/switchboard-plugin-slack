# Slack plugin for Switchboard

Official Slack **user OAuth**, conversations, search, messaging and triage for [Switchboard](https://github.com/tader/switchboard). Actions run as the signed-in user. Node 24 or newer is required; there are no runtime npm dependencies.

## Install and connect

Install `tader/switchboard-plugin-slack`, folder `plugins/slack`, using Switchboard's plugin installer. Its built-in `oauth2` helper is the only dependency. Stable installation requires a published release; before the first release, select the implementation branch explicitly.

Create a Slack app from [the included manifest](plugins/slack/app-manifest.json), replace the example callback URL, and enter the app's client ID and secret under **Plugins → Slack → Settings**. Add a Slack connection and choose read-only or read/write access. Connect separately for each workspace/user pair. The app may require workspace approval. See the [complete setup guide](plugins/slack/docs/setup.md).

OAuth can run directly on a remote Switchboard. There is no local browser-session capture, bot mode, or separate authentication plugin. Credentials are cached and encrypted by Switchboard; rotating tokens renew automatically. Slack administrators can revoke access.

## Tools

The plugin exposes 19 documented operations in Switchboard's Console and MCP discovery:

- Authentication status/renewal and capability reporting.
- Paginated conversations, messages, threads, users, message search, and message permalinks.
- Exact reply contexts and batch threaded replies.
- Send messages, edit/delete your own messages, add/remove reactions, and open DMs.
- Bounded triage and explicit mark-read actions.

Slack's native unread fields are not available for every conversation type. Missing state is **unknown**, never zero. Triage reports scan coverage, continuation cursors, and per-conversation errors. Reading messages, searching, or replying never marks anything read automatically. Mark-unread and per-thread read markers are unsupported. Files, huddles, administrative APIs, and incoming events are outside this version.

Writes require stable idempotency keys. Repeating an accepted operation returns its saved receipt; changing its content with the same key is rejected. An uncertain result blocks automatic resending. See [operation and recovery details](plugins/slack/docs/operations.md).

## Development

```sh
npm ci
npm run check
npm test
SWITCHBOARD_ROOT=/path/to/switchboard npm run integration
```

The integration test uses the actual Switchboard installer, plugin manager, OAuth helper, proxy and API parser with temporary state and fixture providers. It verifies refresh persistence and restart without accessing a live workspace. CI uses Node 24 and a pinned Switchboard core revision.

For opt-in identity-only validation, configure `SWITCHBOARD_URL`, `SWITCHBOARD_TOKEN`, and `SLACK_CONNECTION`, then run `npm run check:access`. An explicit `--write` additionally posts and deletes a disposable message in `SLACK_TEST_CHANNEL`; never select a conversation without permission to test there. Secrets are not printed or written by the diagnostic script. Live Slack authentication and message writes have not been tested as part of initial implementation.

## Releases

The release workflow validates reviewed changes on `main` and publishes a GitHub release when the package version has no release yet. Bump `package.json`, `package-lock.json` and `plugins/slack/plugin.json` together in a PR for later releases. It uses only repository Contents write permission and does not create or approve PRs. The catalog PR must wait for the first stable release. Plugin installation copies only `plugins/slack`; repository-root development files are not runtime requirements.
