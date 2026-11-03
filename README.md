# Slack plugin for Switchboard

Slack **browser/desktop sessions or official user OAuth**, conversations, search, messaging and triage for [Switchboard](https://github.com/tader/switchboard). Actions run as the signed-in user. Node 24 or newer is required; there are no runtime npm dependencies.

## Install and connect

Install `tader/switchboard-plugin-slack`, folder `plugins/slack`, using Switchboard's plugin installer. Its dependencies are the built-in `oauth2` helper and `slack-authentication` from this repository. Stable installation requires a published release; before the first release, select the implementation branch explicitly.

For access without installing a Slack app, install folder `plugins/slack-authentication` on your sign-in computer. Add a **Slack Authentication** connection and choose **Use local Slack desktop session (macOS)** or **Sign in through local browser**. Then create a Slack connection using **Use Slack Authentication** and select that source. See the [authentication setup guide](plugins/slack-authentication/docs/setup.md), including the explicit **Share authentication** permission for remote peers.

Alternatively, create a Slack app from [the included manifest](plugins/slack/app-manifest.json), replace the example callback URL, and enter the app's client ID and secret under **Plugins → Slack → Settings**. Add a Slack connection and choose read-only or read/write access. Connect separately for each workspace/user pair. The app may require workspace approval. See the [complete setup guide](plugins/slack/docs/setup.md).

OAuth can run directly on a remote Switchboard. Browser and desktop sources can also serve explicitly authorized direct peers. Credentials are cached and encrypted by Switchboard; OAuth rotating tokens renew automatically; web sessions reuse cached credentials and reacquire from their source when necessary. Slack administrators can revoke access.

## Tools

The plugin exposes 21 documented operations in Switchboard's Console and MCP discovery:

- Authentication status/renewal and capability reporting.
- Paginated conversations, messages, threads, users, message search, and message permalinks.
- Exact reply contexts and batch threaded replies.
- Send messages, edit/delete your own messages, add/remove reactions, and open DMs.
- Bounded triage and explicit mark-read actions.

Slack's native unread fields are not available for every conversation type. Missing state is **unknown**, never zero. Triage reports scan coverage, continuation cursors, and per-conversation errors. Reading messages, searching, or replying never marks anything read automatically. Mark-unread and per-thread read markers are unsupported. Files, huddles and administrative APIs are outside this version. Optional incoming Socket Mode events require explicit app setup; see the common Messaging guide.

Writes require stable idempotency keys. Repeating an accepted operation returns its saved receipt; changing its content with the same key is rejected. An uncertain result blocks automatic resending. See [operation and recovery details](plugins/slack/docs/operations.md).

## Shared Messaging contract (staged)

Alongside the existing API, the plugin implements the optional provider-independent
Messaging v1 contract in [Switchboard #40](https://github.com/tader/switchboard/pull/40).
See [contract coverage and limitations](plugins/slack/docs/messaging-contract.md).
The core feature remains disabled by default. Socket Mode push requires explicit
Slack app/token setup; bounded reconciliation remains available without it.

## Development

```sh
npm ci
npm run check
npm test
SWITCHBOARD_ROOT=/path/to/switchboard npm run integration
SWITCHBOARD_ROOT=/path/to/staged-contract-core npm run integration:contracts
SWITCHBOARD_ROOT=/path/to/staged-contract-core npm run integration:native
```

The integration test uses the actual Switchboard installer, plugin manager, OAuth helper, proxy and API parser with temporary state and fixture providers. It verifies OAuth refresh persistence, encrypted web-session source selection, source removal and restart without accessing a live workspace. Desktop import was additionally validated against a signed-in macOS Slack session using only identity metadata; browser sign-in has fixture coverage. CI uses Node 24 and a pinned Switchboard core revision.

For opt-in identity-only validation, configure `SWITCHBOARD_URL`, `SWITCHBOARD_TOKEN`, and `SLACK_CONNECTION`, then run `npm run check:access`. An explicit `--write` additionally posts and deletes a disposable message in `SLACK_TEST_CHANNEL`; never select a conversation without permission to test there. Secrets are not printed or written by the diagnostic script. Live message writes have not been tested as part of initial implementation.

## Releases

The release workflow validates reviewed changes on `main` and publishes a GitHub release when the package version has no release yet. Release Please creates reviewed version/changelog PRs and updates the root package/lock and both plugin manifests together. Its verified-head dispatcher runs required CI on bot PRs; the publisher only tags versions after they reach `main` through normal review and checks. The catalog PR must wait for the first stable release. Each plugin folder is independently installable; repository-root development files are not runtime requirements.
