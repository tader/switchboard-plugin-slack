---
title: Connect Slack with an official app
services: [slack]
order: 1
---

# Connect Slack

This plugin uses an official Slack app's user OAuth flow. Calls act as you, within the scopes granted to the app and your workspace permissions. Workspace administrators may require app approval. No bot or local authentication companion is required.

## Create the app

1. Open [Slack's app management page](https://api.slack.com/apps) and create an app **from a manifest** in the workspace you want.
2. Use `app-manifest.json` shipped in this plugin. Replace its example redirect URL with **`{{callbackUrl}}`** before creating the app. This is the same callback URL shown in Switchboard's connection dialog.
3. The template requests user scopes only. Read scopes cover channels/private channels/DMs/group DMs, history, user lookup, message search, and reactions. Write scopes cover messaging, reactions, opening DMs and marking read. The channel-write scopes are required by Slack for read cursors; this plugin does not expose channel administration.
4. The manifest enables token rotation for a newly created app. Slack makes enabling rotation irreversible. If your organization prefers non-rotating credentials, set `settings.token_rotation_enabled` to `false` **before creating the app**; both configurations are supported. Leave PKCE disabled: this is a confidential server client authenticated with its client secret, not a public desktop app.
5. Complete any workspace app approval required by your organization.

See Slack's [user OAuth flow](https://docs.slack.dev/authentication/installing-with-oauth/), [app manifests](https://docs.slack.dev/reference/app-manifest/), and [token rotation](https://docs.slack.dev/authentication/using-token-rotation/).

## Configure Switchboard

1. Copy the app's **Client ID** and **Client Secret** from Basic Information into **Plugins → Slack → Settings**. Do not paste credentials into chats, repository files, or issue reports.
2. Add a **Slack** connection and choose **Sign in with Slack**.
3. Choose **Read only** (the default) or **Read, reply and update read markers**. The plugin requests scopes for that mode and independently enforces read-only mode at its API boundary.
4. Complete Slack's authorization in your browser. The resulting identity is bound to both workspace and user. Add another connection for another workspace/account; reconnecting cannot silently switch an existing connection to someone else.
5. Call `getSlackStatus` to test identity without reading messages. `renew=true` exercises rotation for expiring tokens. Non-rotating tokens are validated without requesting another sign-in.

You can authorize directly on a remote Switchboard. Received connections shared through Peers use the existing Switchboard connection-sharing controls; OAuth credentials remain on the instance owning the connection. This plugin does not add credential-export or authentication-source sharing.

## Permissions and reconnection

Missing scopes produce `missing_scope` errors rather than triggering consent automatically. Update the app's user scopes and reconnect explicitly when changing access level. Selecting read-only restricts plugin operations but does not revoke broader scopes previously granted to the app; manage those in Slack.

Expired or revoked refresh tokens require reconnection. Temporary network/token-service failures remain retryable and do not discard the cached session. Reconnecting preserves the connection and durable write journal. Changing the configured app client ID requires a new authorization.

The diagnostic and plugin never log tokens. Switchboard stores credentials and refresh rotations encrypted. Auth status returns identity and expiry only; the plugin has no raw-token endpoint. Disconnecting locally removes the connection without uninstalling the Slack app or globally revoking other connections. Manage workspace installation/revocation in Slack.
