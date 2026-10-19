import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SlackService, compareTs } from "../plugins/slack/lib/service.js";
import { operations, openapi } from "../plugins/slack/lib/operations.js";
import { createAdapter } from "../plugins/slack/lib/adapter.js";
import { validate } from "../plugins/slack/lib/validate.js";
import { credentials, context, oauthFixture } from "./fixture.js";
import { fail } from "../plugins/slack/lib/errors.js";
const op = (id) => operations.find((o) => o.id === id),
  chan = "C12345678",
  stamp = "1792400000.000001";
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-service-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  let responder = async () => ({ ok: true });
  const client = {
    call: async (c, m, a) => {
      calls.push({ m, a });
      return responder(c, m, a);
    },
  };
  return {
    dir,
    calls,
    client,
    service: new SlackService(client, dir),
    conn: { credentials: credentials(), config: { access: "write" } },
    respond: (fn) => (responder = fn),
  };
}
test("listing, pagination, threads and search use the correct native arguments without marking read", async (t) => {
  const f = await fixture(t);
  f.respond(async (c, m, a) =>
    m === "search.messages"
      ? {
          messages: {
            matches: [{ ts: stamp }],
            paging: { page: 1, pages: 2, total: 3 },
          },
        }
      : {
          messages: [{ ts: stamp }],
          response_metadata: { next_cursor: "next" },
        },
  );
  assert.equal(
    (
      await f.service.invoke(
        op("listSlackMessages"),
        { channel: chan, limit: 10, cursor: "prior" },
        f.conn,
      )
    ).nextCursor,
    "next",
  );
  await f.service.invoke(
    op("getSlackThread"),
    { channel: chan, threadTs: stamp, limit: 10 },
    f.conn,
  );
  assert.equal(f.calls.at(-1).a.ts, stamp);
  const search = await f.service.invoke(
    op("searchSlackMessages"),
    { query: "in:team hello", page: 1, count: 10 },
    f.conn,
  );
  assert.equal(search.nextPage, 2);
  assert(!f.calls.some((c) => c.m === "conversations.mark"));
  assert.equal(compareTs("1792400000.000001", "1792400000.000002"), -1);
});
test("triage preserves unknown channel state and reports per-conversation permission failures", async (t) => {
  const f = await fixture(t);
  f.respond(async (c, m, a) =>
    m === "users.conversations"
      ? {
          channels: [{ id: chan }, { id: "D12345678" }, { id: "G12345678" }],
          response_metadata: { next_cursor: "next" },
        }
      : a.channel === chan
        ? { channel: { id: chan, name: "team" } }
        : a.channel === "D12345678"
          ? {
              channel: {
                id: a.channel,
                is_im: true,
                unread_count: 2,
                last_read: stamp,
              },
            }
          : Promise.reject(fail("missing_scope", 403)),
  );
  const result = await f.service.invoke(
    op("getSlackTriageInbox"),
    { limit: 3 },
    f.conn,
  );
  assert.equal(result.items[0].unread, null);
  assert.equal(result.items[0].unreadCount, null);
  assert.equal(result.items[1].unread, true);
  assert.equal(result.items[2].error.code, "missing_scope");
  assert.equal(result.complete, false);
  assert.equal(result.nextCursor, "next");
});
test("replies validate exact thread roots, deduplicate sends and never mark read automatically", async (t) => {
  const f = await fixture(t);
  f.respond(async (c, m) =>
    m === "conversations.replies"
      ? { messages: [{ ts: stamp }] }
      : { channel: chan, ts: "1792400001.000001" },
  );
  const input = {
    channel: chan,
    threadTs: stamp,
    text: "reply",
    idempotencyKey: "reply-key",
  };
  await f.service.invoke(op("postSlackMessage"), input, f.conn);
  const replay = await f.service.invoke(op("postSlackMessage"), input, f.conn);
  assert(replay.replayed);
  assert.equal(f.calls.filter((c) => c.m === "chat.postMessage").length, 1);
  assert(!f.calls.some((c) => c.m === "conversations.mark"));
  f.respond(async () => ({
    messages: [{ ts: "1792400000.000002", thread_ts: stamp }],
  }));
  await assert.rejects(
    f.service.invoke(
      op("postSlackMessage"),
      { ...input, idempotencyKey: "wrong-root", threadTs: "1792400000.000002" },
      f.conn,
    ),
    { code: "invalid_thread_target" },
  );
});
test("edits enforce authorship and expected text; read-only connections reject every write operation", async (t) => {
  const f = await fixture(t);
  f.respond(async () => ({
    messages: [{ ts: stamp, user: "U99999999", text: "before" }],
  }));
  const input = {
    channel: chan,
    ts: stamp,
    expectedText: "before",
    text: "after",
    idempotencyKey: "edit-key",
  };
  await assert.rejects(
    f.service.invoke(op("editSlackMessage"), input, f.conn),
    { code: "not_your_message" },
  );
  f.respond(async () => ({
    messages: [{ ts: stamp, user: "U12345678", text: "different" }],
  }));
  await assert.rejects(
    f.service.invoke(op("editSlackMessage"), input, f.conn),
    { code: "stale_message" },
  );
  for (const operation of operations.filter((o) => o.write))
    await assert.rejects(
      f.service.invoke(
        operation,
        {},
        { ...f.conn, config: { access: "read" } },
      ),
      { code: "permission_denied" },
    );
  assert(!f.calls.some((c) => c.m === "chat.update"));
});
test("mark-read requires a selected existing target and cannot move an advanced marker backwards", async (t) => {
  const f = await fixture(t);
  f.respond(async (c, m) =>
    m === "conversations.history"
      ? { messages: [{ ts: stamp }] }
      : m === "conversations.info"
        ? { channel: { last_read: "1792400001.000000" } }
        : { ok: true },
  );
  await assert.rejects(
    f.service.invoke(
      op("markSlackRead"),
      { channel: chan, ts: stamp, state: "read", idempotencyKey: "read-key" },
      f.conn,
    ),
    { code: "read_marker_already_advanced" },
  );
  assert(!f.calls.some((c) => c.m === "conversations.mark"));
  assert.throws(
    () =>
      validate(
        {
          channel: chan,
          ts: stamp,
          state: "unread",
          idempotencyKey: "read-key",
        },
        op("markSlackRead").input,
      ),
    { code: "invalid_input" },
  );
});
test("batch replies preserve per-item failures and reject duplicated keys", async (t) => {
  const f = await fixture(t);
  f.respond(async (c, m, a) =>
    m === "conversations.replies"
      ? { messages: [{ ts: stamp }] }
      : a.channel === chan
        ? { channel: chan, ts: stamp }
        : Promise.reject(fail("missing_scope", 403, { definitive: true })),
  );
  const items = [
    {
      channel: chan,
      threadTs: stamp,
      text: "first",
      idempotencyKey: "batch-one",
    },
    {
      channel: "C99999999",
      threadTs: stamp,
      text: "second",
      idempotencyKey: "batch-two",
    },
  ];
  const result = await f.service.invoke(
    op("replySlackBatch"),
    { items },
    f.conn,
  );
  assert(result.items[0].result.ok);
  assert.equal(result.items[1].error.code, "missing_scope");
  await assert.rejects(
    f.service.invoke(
      op("replySlackBatch"),
      { items: [items[0], items[0]] },
      f.conn,
    ),
    { code: "duplicate_idempotency_key" },
  );
});
test("loopback invocations are single-use, path-bound and expose no Slack token hook", async (t) => {
  const f = await fixture(t);
  f.respond(async () => ({ team_id: "T12345678", user_id: "U12345678" }));
  const instance = await createAdapter(
    { ...context(oauthFixture()), dataDir: f.dir },
    { client: f.client },
  );
  t.after(() => instance.dispose());
  const service = instance.services[0],
    auth = service.authMethods[0];
  assert.equal(auth.token, undefined);
  const req = {
    method: "GET",
    url: new URL("/status", service.baseUrl),
    headers: new Headers(),
  };
  await auth.authorize(req, f.conn);
  assert(!req.headers.get("authorization").includes("fixture-access"));
  const bad = new URL(req.url);
  bad.pathname = "/capabilities";
  assert.equal((await fetch(bad, { headers: req.headers })).status, 401);
  assert.equal(
    (await fetch(req.url, { headers: req.headers })).status,
    401,
    "a mismatched use consumes the invocation",
  );
  const next = {
    method: "GET",
    url: new URL("/status", service.baseUrl),
    headers: new Headers(),
  };
  await auth.authorize(next, f.conn);
  const response = await fetch(next.url, { headers: next.headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  assert.equal((await fetch(next.url, { headers: next.headers })).status, 401);
  await assert.rejects(
    auth.authorize(
      {
        method: "GET",
        url: new URL("https://evil.test/status"),
        headers: new Headers(),
      },
      f.conn,
    ),
    { code: "request_forbidden" },
  );
  assert(!JSON.stringify(openapi).includes("fixture-access"));
});
test("raw read-only writes and invalid inputs fail inside the adapter before any Slack data call", async (t) => {
  const f = await fixture(t),
    instance = await createAdapter(
      { ...context(oauthFixture()), dataDir: f.dir },
      { client: f.client },
    );
  t.after(() => instance.dispose());
  const auth = instance.services[0].authMethods[0];
  for (const [url, method, body, expected] of [
    [
      "/messages",
      "POST",
      { channel: chan, text: "bad", idempotencyKey: "readonly-key" },
      403,
    ],
    ["/messages?channel=bad&limit=100000", "GET", undefined, 400],
  ]) {
    const req = {
      url: new URL(url, "http://slack.localhost"),
      method,
      headers: new Headers(),
    };
    await auth.authorize(req, { ...f.conn, config: { access: "read" } });
    const r = await fetch(req.url, {
      method,
      headers: req.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(r.status, expected);
  }
  assert.equal(f.calls.length, 0);
});

test("own edits/deletes, reactions, DMs and explicit read markers succeed with small replayable receipts", async (t) => {
  const f = await fixture(t);
  f.respond(async (c, m, a) => {
    if (m === "conversations.history")
      return { messages: [{ ts: stamp, user: c.userId, text: "before" }] };
    if (m === "conversations.info")
      return { channel: { last_read: "1792300000.000000" } };
    if (m === "conversations.open") return { channel: { id: "D12345678" } };
    return { ok: true, channel: chan, ts: stamp };
  });
  for (const [id, input, method] of [
    [
      "editSlackMessage",
      { text: "after", expectedText: "before" },
      "chat.update",
    ],
    ["deleteSlackMessage", { expectedText: "before" }, "chat.delete"],
    ["addSlackReaction", { name: "thumbsup" }, "reactions.add"],
    ["removeSlackReaction", { name: "thumbsup" }, "reactions.remove"],
    ["markSlackRead", { state: "read" }, "conversations.mark"],
  ]) {
    const result = await f.service.invoke(
      op(id),
      { channel: chan, ts: stamp, idempotencyKey: "success-" + id, ...input },
      f.conn,
    );
    assert(result.ok);
    assert.equal(f.calls.at(-1).m, method);
  }
  assert.equal(
    (
      await f.service.invoke(
        op("openSlackConversation"),
        { users: ["U87654321"], idempotencyKey: "open-dm-key" },
        f.conn,
      )
    ).channel,
    "D12345678",
  );
  const caps = await f.service.invoke(op("getSlackCapabilities"), {}, f.conn);
  assert.equal(caps.features.send, true);
  assert.equal(caps.markUnread, false);
});

test("malformed write receipts remain uncertain rather than allowing a duplicate send", async (t) => {
  const f = await fixture(t);
  f.respond(async () => ({ ok: true }));
  const input = { channel: chan, text: "test", idempotencyKey: "bad-receipt" };
  await assert.rejects(
    f.service.invoke(op("postSlackMessage"), input, f.conn),
    { code: "invalid_write_receipt" },
  );
  await assert.rejects(
    f.service.invoke(op("postSlackMessage"), input, f.conn),
    { code: "uncertain" },
  );
  assert.equal(f.calls.filter((c) => c.m === "chat.postMessage").length, 1);
});
