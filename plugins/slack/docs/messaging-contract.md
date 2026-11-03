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
attachments and reactions are not expanded. The text fallback decodes Slack's three
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
history through common operations. There is no contract `watch` hook yet: Slack
Events API or Socket Mode would need separate explicit provider setup. Local SSE
and peer relay do not turn reconciliation into native Slack push.

Common conversation creation, edit/delete, reactions, read-state mutations and
thread enumeration are not advertised yet. Existing Slack-specific operations stay
available with their existing preconditions and semantics. Capabilities must not be
inferred from those legacy endpoints.

The tests use an offline Slack fixture behind the real adapter and core proxy,
HTTP/SSE routes. They check the canonical schema, target/thread mapping, scope and
read-only enforcement, signed cursors, restricted content, durable writes, replay,
uncertain outcomes, metadata publication and terminal authentication pause. No live
workspace messages are sent.
