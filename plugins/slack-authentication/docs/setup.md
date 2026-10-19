---
title: Sign in to Slack on this computer
services: [slack-authentication]
order: 1
---

# Slack Authentication

Install `tader/switchboard-plugin-slack`, folder `plugins/slack-authentication`, on the computer where you sign in. Add a **Slack Authentication** connection and enter your workspace URL, such as `https://your-workspace.slack.com` or a workspace link `https://app.slack.com/client/T…`.

Choose one of these methods:

- **Use local Slack desktop session (macOS)** imports the selected workspace's existing Slack session. Be signed in and open that workspace in Slack first. macOS may request permission to read **Slack Safe Storage** in Keychain. Denying access leaves browser sign-in available. The plugin reads only Slack's cookie database and workspace-token storage, does not modify or launch Slack, and does not read messages during import. Direct-download and Mac App Store locations are supported. Other desktop operating systems and unsupported storage/encryption formats should use browser sign-in.
- **Sign in through local browser** uses Chrome or Edge with a dedicated private profile. Complete normal Slack sign-in, SSO and MFA. Cached sign-in is tried first, and the browser closes after acquiring the session. Configure the browser executable in plugin settings if it is not detected. Browser automation is used only for authentication; data operations use HTTPS APIs.

Neither method installs a Slack app or requests OAuth consent. They reuse the signed-in user's current session and permissions. Your organization can restrict session reuse, devices, network access and session lifetimes; this flow does not change those policies. Slack's web-session protocol is unofficial and may change.

## Connect Slack and share authentication

Install the **Slack** plugin from folder `plugins/slack`. Add a Slack connection, choose **Use Slack Authentication**, select the authentication connection and choose read-only or read/write access. No Slack app client ID or secret is needed. The identity is bound to a workspace/user pair; reconnecting cannot switch accounts silently. Add separate connections for other accounts or workspaces.

For a remote Switchboard, share the local authentication connection with the peer through **Peers**, and separately enable **Share authentication** for that peer. The remote Slack connection can then select that source. Both instances require a Switchboard version supporting authentication sources. Ordinary connection sharing alone does not grant access to credentials. Credential forwarding through another peer is not supported. Share only with trusted peers: the session token and its paired cookie grant the same native session access even when a Slack product connection restricts operations to read-only.

## Caching and recovery

Switchboard caches the workspace token and the minimum required session cookie in its encrypted credential store, together with the account identity and browser user-agent when available. The browser profile stays on the sign-in device with restricted permissions; it is never transferred to peers. The Slack desktop Keychain password is used only in memory to decrypt the cookie and is never saved or shared. Logs and status endpoints do not expose tokens or cookies, and there is no raw-token endpoint.

Slack connections reuse the cached session until Slack rejects it, including while the source device is temporarily offline. After rejection, they obtain the source's current credentials before requesting a fresh import. The source validates identity before exporting a session. Browser sources try silent renewal from their dedicated profile; desktop sources re-read the explicitly configured local Slack session. No OAuth refresh endpoint exists for this session type. If Slack has signed you out or requires interaction, reconnect **Slack Authentication on its own device**, then retry the existing remote connection. Transient API failures do not discard credentials. `getSlackStatus` with `renew=true` checks the current source without reading messages.

Disconnecting the authentication source removes its dedicated browser profile. It does not sign out the official Slack app or revoke Slack sessions globally. Removing or unsharing a source blocks its dependent connections. Manage global session revocation in Slack.
