---
title: Shared Messaging contract
services: [slack]
order: 3
---

# Shared Messaging v1 (staged)

This is the optional generic contract beside the existing Slack operations. It
requires the staged core from [Switchboard #40](https://github.com/tader/switchboard/pull/40)
and `SWITCHBOARD_SHARED_CONTRACTS=1`. It does not change authentication configuration,
request broader scopes, configure cloud subscriptions or enable the core feature.

Implemented common operations:

- `messaging.conversations.list` and `.get`.
- `messaging.messages.list` and `.get`.
- `messaging.messages.send`, including replies into existing threads.
- `messaging.reactions.update`, when reaction write access is granted.

Discovery uses actual granted OAuth read/history/write scopes, the configured
read-only boundary, or the native permission checks of an explicitly selected web
session. OAuth conversation types are restricted to those with granted read scopes;
partial grants produce explicit partial coverage. A history read checks the target
conversation type and corresponding history grant before reading messages. Missing
resource permissions do not masquerade as empty success. No read sends a read marker.

Ids are opaque and scoped to the connection. Clients must not parse message or
thread ids. An exact thread reply id retains the root needed for a bounded lookup.
Pass the returned `threadId` to `messaging.messages.list` to read its root/replies.
The default history does not expand all threads. Page cursors are HMAC-signed, bound
to connection/account/query/limit, and survive restarts using an owner-only local key.
Do not reuse them with another thread or query. A missing exact message is not a
complete deletion feed.

Message pages use at most 15 records and expose continuation cursors. Retention and
unexpanded thread history mean conversation history is not a complete snapshot;
thread pages also report retained/partial coverage. Never infer deletion from a
missing message. Limits and retries remain subject to the provider's `Retry-After`;
see [Slack history](https://docs.slack.dev/reference/methods/conversations.history/)
and [thread pagination](https://docs.slack.dev/reference/methods/conversations.replies/).

Hidden/restricted/deleted content has null text. Missing bodies, unread counts,
activity timestamps and sender ownership remain explicitly unknown. File contents,
attachments are not expanded. Authorized reaction snapshots include available counts and own state; incomplete user lists leave own state unknown. Standard emoji map to Slack names, and custom emoji use `:name:`. The text fallback decodes Slack's three
escaped control characters; Slack mention/link ids or formatting in existing text
are not resolved into rich objects. Timestamps preserve millisecond precision.

Sends accept up to 4000 UTF-16 code units of text and use literal text: mrkdwn,
control markup and automatic link/media unfurling are disabled. A `replyToId` targets
the root's thread; an optional `threadId` must agree. Core keys are namespaced and
reused in the existing durable account ledger. Receipts contain metadata only.
Accepted writes replay; changed payloads conflict; ambiguous dispatch stays uncertain
without resending. Credentials and outgoing message bodies are never stored in this
ledger. See [Slack text formatting](https://docs.slack.dev/messaging/formatting-message-text/).

`collect` validates account authentication and emits a broad metadata-only scope
invalidation. Core schedules it only under an authorized activity lease, with the
15-minute reconciliation policy, cooldown/backoff and persistent auth pause. It is
not a provider delta/deletion stream. Clients re-read the affected conversation or
history through common operations. The optional Socket Mode hook below requires
explicit provider setup. Local SSE and peer relay alone do not make polling native
Slack push.

Common conversation creation, edit/delete, reactions, read-state mutations and
thread enumeration are not advertised yet. Existing Slack-specific operations stay
available with their existing preconditions and semantics. Capabilities must not be
inferred from those legacy endpoints.

The tests use an offline Slack fixture behind the real adapter and core proxy,
HTTP/SSE routes. They check the canonical schema, target/thread mapping, scope and
read-only enforcement, signed cursors, restricted content, durable writes, replay,
uncertain outcomes, metadata publication and terminal authentication pause. No live
workspace messages are sent.

## Optional native Socket Mode

Native events are opt-in. The normal app manifest remains unchanged. The separate
`socket-mode-app-manifest.json` example enables message/reaction user events; apply
it explicitly to your Slack app and review the scopes/events in Slack. There is no
automatic app creation, consent expansion or cloud subscription registration.

Enable Socket Mode in Slack and create an app-level `xapp` token with
`connections:write` and `authorizations:read`. Set the plugin's **Enable Socket Mode
events**, **Socket Mode Slack app ID** (`A...`) and secret **Socket Mode app-level
token** settings. Use an app installed for each relevant workspace/user. User data
reads and writes continue through the connection's own credentials and permissions;
the app token is only sent to two fixed Slack app-level API methods. A rejected app
token disables native receive work without pausing otherwise working user OAuth or
fallback reconciliation. Core discovery reports native support only when configured.

One socket is shared by active connection receivers. Slack load-balances events
across sockets for the same app, so do not run independent receivers for this app
token on other instances unless they share a durable delivery router. A hello that
reports multiple sockets backs off instead of claiming complete receive coverage. Switchboard
peers already keep provider receive work at the connection owner; use a dedicated
Slack event app per independent owner installation.

The receiver verifies the connected app ID and resolves the complete event
installation list with `apps.event.authorizations.list` when an event context is
present and the payload does not already cover every active user. Without a context, only explicitly listed installations are considered.
Only matching workspace/user non-bot installations receive invalidations; the event's
acting user is not treated as an authorization. Event bodies, names and channel IDs
are discarded at ingress. The common feed contains metadata scope invalidation.

Slack envelope acknowledgement follows successful durable publication for all
relevant active connections. Failures are not acknowledged. Source event IDs let
the core deduplicate retries after reconnect/restart. Socket Mode has no historical
replay API: every watch/connect emits `resync.required` so clients refresh current
state. Provider rate-limit notices also request resync. Scheduled socket refresh is
handled with one socket at a time; unexpected failures use core native backoff.

Core activity leases stop each receiver after inactivity grace; the last receiver
closes the app socket and cancels app HTTP work. Terminal user-auth failures stop
native and fallback work until credentials change. Native app errors stay separate.
Input frames (1 MiB), queued metadata (256), and authorization traversal (20 pages)
are bounded; overflow or incomplete routing closes receive work without ACK and
requires a new resync. No message sends or read markers occur in the receive loop.

`npm run integration:native` uses offline Slack/socket fixtures with the real core
HTTP/SSE, durable checkpoint/event database and activity/auth runtime. It covers
post-commit ACK, replay/deduplication, metadata-only storage, expired activity and
terminal authentication stop. Fixture success does not prove live app configuration.

Sources: [Socket Mode lifecycle and acknowledgement](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Events API visibility](https://docs.slack.dev/apis/events-api/),
[installation authorization lookup](https://docs.slack.dev/reference/methods/apps.event.authorizations.list/).

## Native desktop/web-session delivery

Web-session connections now receive RTM invalidations using the same imported
`xoxc` token, `d` cookie and user agent as normal reads. No app installation,
Socket Mode toggle or app-level token is needed. The authenticated `rtm.connect`
response must match both the connection's workspace and user. Cookies go only
to the validated Slack websocket endpoint; ticket URLs and message bodies are
never published in the event stream.

The receive socket lives only while the core holds a watch lease. Abort,
plugin disposal, revoked access, invalid sessions and account mismatches close
it. A bounded queue, hello timeout and ping watchdog detect stalled receivers.
A new connection emits `resync.required`; disconnection is not represented as
continuous coverage. The core manages retry, backoff and lease expiry. This
web-session protocol is not a promised public Slack API, so reconciliation
remains necessary after interruptions or provider changes.

When explicit Socket Mode app settings are configured, that transport retains
priority. OAuth-only connections without those settings do not claim native
push support. Existing operations, access scopes and read-only restrictions
remain in force.
