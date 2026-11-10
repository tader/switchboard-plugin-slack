import { SlackService } from "../plugins/slack/lib/service.js";
import { operations as legacyOperations } from "../plugins/slack/lib/operations.js";
import { MessagingCursors } from "../plugins/slack/lib/messaging-cursors.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import {
  contractsFixture,
  channelId,
  ownId,
  rootId,
  replyId,
} from "./contracts-fixture.js";
import {
  createMessaging,
  projectMessage,
} from "../plugins/slack/lib/messaging.js";
import { messagingOperations } from "../plugins/slack/lib/messaging-schema.js";
import { fail } from "../plugins/slack/lib/errors.js";
const ajv = new Ajv({ strict: false });
async function invoke(f, name, input, context = f.invocation()) {
  const op = f.service.contracts.operations[name],
    common = messagingOperations[name];
  for (const schema of [common.inputSchema, op.inputSchema]) {
    const valid = ajv.compile(schema);
    assert.ok(valid(input), JSON.stringify(valid.errors));
  }
  const result = await op.invoke(input, context),
    valid = ajv.compile(common.outputSchema);
  assert.ok(valid(result), JSON.stringify(valid.errors));
  return result;
}
test("Messaging discovery respects granted scopes, read-only and native session watch support", async (t) => {
  const f = await contractsFixture(t),
    contract = f.service.contracts;
  assert.equal(contract.version, 1);
  assert.equal(typeof contract.watch, "function");
  assert.deepEqual(
    contract.available(f.connection).sort(),
    Object.keys(contract.operations).sort(),
  );
  assert.ok(
    !contract
      .available({ ...f.connection, config: { access: "read" } })
      .includes("messaging.messages.send"),
  );
  const restricted = {
    ...f.connection,
    credentials: { ...f.connection.credentials, scope: "im:read" },
  };
  assert.deepEqual(contract.available(restricted), [
    "messaging.conversations.list",
    "messaging.conversations.get",
  ]);
  const page = await invoke(
    f,
    "messaging.conversations.list",
    {},
    f.invocation(restricted),
  );
  assert.equal(f.calls.at(-1).args.types, "im");
  assert.equal(page.coverage.complete, false);
  assert.equal(page.items[0].unread, null);
  assert.equal(page.items[0].updatedAt, null);
  const web = {
    ...f.connection,
    credentials: { ...f.connection.credentials, kind: "web", scope: "" },
  };
  assert.equal(contract.available(web).length, 6);
  await assert.rejects(
    invoke(
      f,
      "messaging.messages.send",
      { conversationId: channelId, text: "No" },
      f.invocation({ ...f.connection, config: { access: "read" } }),
    ),
    (e) => e.code === "permission_denied",
  );
  assert.equal(
    f.calls.filter((c) => c.method === "chat.postMessage").length,
    0,
  );
});
test("canonical message reads preserve restricted content, ownership and partial history without read markers", async (t) => {
  const f = await contractsFixture(t);
  f.respond(async (method) =>
    method === "conversations.history"
      ? {
          messages: [
            { ts: rootId, text: "Hello", user: ownId },
            {
              ts: "1700000002.000001",
              text: "PRIVATE-HIDDEN",
              user: ownId,
              hidden: true,
            },
            {
              ts: "1700000003.000001",
              text: "PRIVATE-DELETED",
              subtype: "tombstone",
            },
            { ts: "1700000004.000001", files: [{}], bot_id: "B12345678" },
          ],
          is_limited: true,
        }
      : undefined,
  );
  const page = await invoke(f, "messaging.messages.list", {
    conversationId: channelId,
  });
  assert.equal(page.coverage.complete, false);
  assert.equal(page.items[0].isOwn, true);
  assert.equal(page.items[1].text, null);
  assert.equal(page.items[1].contentState, "restricted");
  assert.equal(page.items[2].text, null);
  assert.equal(page.items[2].contentState, "deleted");
  assert.equal(page.items[3].text, null);
  assert.equal(page.items[3].contentType, "media");
  assert.equal(page.items[3].isOwn, false);
  assert.equal(
    f.calls.find((c) => c.method === "conversations.history").args.limit,
    15,
  );
  assert.ok(!JSON.stringify(page).includes("PRIVATE-"));
  assert.ok(!f.calls.some((c) => c.method === "conversations.mark"));
});
test("signed cursors survive adapter recreation and reject account/query tampering", async (t) => {
  const f = await contractsFixture(t);
  f.respond(async (method) =>
    method === "conversations.history"
      ? { messages: [], response_metadata: { next_cursor: "provider-next" } }
      : undefined,
  );
  const page = await invoke(f, "messaging.messages.list", {
    conversationId: channelId,
    limit: 10,
  });
  assert.ok(page.nextCursor);
  assert.ok(!page.nextCursor.includes("provider-next"));
  f.service.contracts = createMessaging(f.dir);
  await invoke(f, "messaging.messages.list", {
    conversationId: channelId,
    limit: 10,
    cursor: page.nextCursor,
  });
  assert.equal(f.calls.at(-1).args.cursor, "provider-next");
  const base = {
    conversationId: channelId,
    limit: 10,
    cursor: page.nextCursor,
  };
  for (const [input, conn] of [
    [{ ...base, limit: 11 }, f.connection],
    [{ ...base, conversationId: "C23456789" }, f.connection],
    [{ ...base, cursor: page.nextCursor + "x" }, f.connection],
    [base, { ...f.connection, id: "other-binding" }],
    [
      base,
      {
        ...f.connection,
        credentials: { ...f.connection.credentials, userId: "U23456789" },
      },
    ],
  ])
    await assert.rejects(
      invoke(f, "messaging.messages.list", input, f.invocation(conn)),
      (e) => e.code === "invalid_cursor",
    );
  if (process.platform !== "win32")
    assert.equal(
      (await fs.stat(path.join(f.dir, "messaging-cursor-key"))).mode & 0o777,
      0o600,
    );
});
test("exact reads and threaded sends use opaque stable targets and bounded native lookups", async (t) => {
  const f = await contractsFixture(t);
  const receipt = await invoke(f, "messaging.messages.send", {
    conversationId: channelId,
    text: "Reply",
    replyToId: rootId,
  });
  assert.equal(receipt.status, "accepted");
  assert.notEqual(receipt.resourceId, replyId);
  const get = await invoke(f, "messaging.messages.get", {
    conversationId: channelId,
    id: receipt.resourceId,
  });
  assert.equal(get.id, receipt.resourceId);
  assert.equal(get.threadId, rootId);
  assert.equal(get.replyToId, rootId);
  const native = f.calls.findLast(c => c.method === "conversations.replies");
  assert.equal(native.method, "conversations.replies");
  assert.equal(native.args.oldest, replyId);
  assert.equal(native.args.latest, replyId);
  assert.equal(native.args.limit, 1);
  assert.equal(native.args.inclusive, true);
  await assert.rejects(
    invoke(f, "messaging.messages.send", {
      conversationId: channelId,
      text: "bad",
      replyToId: rootId,
      threadId: "1700000009.000001",
    }),
    (e) => e.code === "invalid_request",
  );
});
test("nested durable keys prevent replay, conflict and uncertain resend while excluding content from receipts", async (t) => {
  const f = await contractsFixture(t),
    input = {
      conversationId: channelId,
      text: "PRIVATE-BODY & <@everyone> *literal*",
    };
  const first = await invoke(f, "messaging.messages.send", input);
  assert.deepEqual(await invoke(f, "messaging.messages.send", input), first);
  const post = f.calls.filter((c) => c.method === "chat.postMessage");
  assert.equal(post.length, 1);
  assert.equal(post[0].args.mrkdwn, false);
  assert.equal(post[0].args.parse, "none");
  assert.ok(post[0].args.text.includes("&lt;@everyone&gt;"));
  await assert.rejects(
    invoke(f, "messaging.messages.send", { ...input, text: "changed" }),
    (e) => e.code === "idempotency_conflict",
  );
  f.respond(async (method) => {
    if (method === "chat.postMessage")
      throw fail("internal_error", 400, { definitive: false });
  });
  const uncertain = f.invocation(f.connection, "uncertain-key");
  assert.deepEqual(
    await invoke(f, "messaging.messages.send", input, uncertain),
    { status: "uncertain" },
  );
  assert.deepEqual(
    await invoke(f, "messaging.messages.send", input, uncertain),
    { status: "uncertain" },
  );
  assert.equal(
    f.calls.filter((c) => c.method === "chat.postMessage").length,
    2,
  );
  const files = await fs.readdir(path.join(f.dir, "operations"), {
    recursive: true,
  });
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const saved = await fs.readFile(
      path.join(f.dir, "operations", file),
      "utf8",
    );
    assert.ok(!saved.includes("PRIVATE-BODY"));
    assert.ok(!saved.includes("fixture-access"));
  }
});
test("reconciliation emits metadata invalidation and preserves terminal auth, rate limits and resource permission errors", async (t) => {
  const f = await contractsFixture(t),
    contract = f.service.contracts;
  const batch = await contract.collect({}, f.invocation());
  assert.equal(batch.events[0].event.type, "invalidated");
  assert.equal(f.calls.at(-1).method, "auth.test");
  for (const [code, status, expected] of [
    ["invalid_auth", 401, "authentication_required"],
    ["ratelimited", 429, "rate_limited"],
    ["no_permission", 403, "permission_denied"],
    ["internal_error", 400, "source_unavailable"],
  ]) {
    f.respond(async () => {
      throw fail(code, status, { retryAfter: 123 });
    });
    await assert.rejects(
      contract.collect({}, f.invocation()),
      (e) =>
        e.code === expected && (status !== 429 || e.retryAfterMs === 123000),
    );
  }
  const partial = {
    ...f.connection,
    credentials: {
      ...f.connection.credentials,
      scope: "im:read im:history channels:read",
    },
  };
  f.respond(undefined);
  await assert.rejects(
    invoke(
      f,
      "messaging.messages.list",
      { conversationId: channelId },
      f.invocation(partial),
    ),
    (e) => e.code === "permission_denied",
  );
  assert.ok(!f.calls.some((c) => c.method === "conversations.history"));
});
test("thread history uses the common filter, binds pagination and exposes root discovery", async (t) => {
  const f = await contractsFixture(t);
  f.respond(async (method, args) =>
    method === "conversations.history"
      ? { messages: [{ ts: rootId, text: "Root", reply_count: 2 }] }
      : method === "conversations.replies"
        ? {
            messages: [
              { ts: replyId, thread_ts: rootId, text: "Reply", user: ownId },
            ],
            response_metadata: { next_cursor: "thread-next" },
          }
        : undefined,
  );
  const root = await invoke(f, "messaging.messages.list", {
    conversationId: channelId,
  });
  assert.equal(root.items[0].threadId, rootId);
  const page = await invoke(f, "messaging.messages.list", {
    conversationId: channelId,
    threadId: rootId,
  });
  assert.equal(page.items[0].replyToId, rootId);
  assert.equal(page.items[0].authorDisplayName, "Fixture name");
  assert.equal(page.coverage.complete, false);
  assert.equal(f.calls.findLast(c => c.method === "conversations.replies").args.ts, rootId);
  assert.equal(f.calls.findLast(c => c.method === "conversations.replies").args.limit, 15);
  await invoke(f, "messaging.messages.list", {
    conversationId: channelId,
    threadId: rootId,
    cursor: page.nextCursor,
  });
  assert.equal(f.calls.at(-1).args.cursor, "thread-next");
  await assert.rejects(
    invoke(f, "messaging.messages.list", {
      conversationId: channelId,
      cursor: page.nextCursor,
    }),
    (e) => e.code === "invalid_cursor",
  );
  assert.throws(() =>
    projectMessage({ ts: "invalid", text: "hidden" }, channelId, ownId),
  );
});

test("concurrent initializers publish one complete persistent cursor key", async (t) => {
  const f = await contractsFixture(t),
    codecs = Array.from({ length: 8 }, () => new MessagingCursors(f.dir)),
    binding = ["connection", "query"];
  const tokens = await Promise.all(
    codecs.map((c) => c.encode(binding, "next")),
  );
  assert.deepEqual(
    await Promise.all(tokens.map((token) => codecs[0].decode(binding, token))),
    Array(8).fill("next"),
  );
});

test("write-only bindings can send while unsupported reply targets and per-resource scopes do not become auth failures", async (t) => {
  const f = await contractsFixture(t),
    conn = {
      ...f.connection,
      credentials: { ...f.connection.credentials, scope: "chat:write" },
    },
    ctx = f.invocation(conn, "write-only-key");
  assert.deepEqual(f.service.contracts.available(conn), [
    "messaging.messages.send",
  ]);
  assert.equal(
    (
      await invoke(
        f,
        "messaging.messages.send",
        { conversationId: channelId, text: "Plain" },
        ctx,
      )
    ).status,
    "accepted",
  );
  await assert.rejects(
    invoke(
      f,
      "messaging.messages.send",
      { conversationId: channelId, text: "Reply", replyToId: rootId },
      f.invocation(conn, "write-only-reply"),
    ),
    (e) => e.code === "permission_denied",
  );
  assert.equal(
    f.calls.filter((c) => c.method === "chat.postMessage").length,
    1,
  );
  f.respond(async (method) => {
    if (method === "conversations.info") throw fail("missing_scope", 403);
  });
  await assert.rejects(
    invoke(f, "messaging.messages.list", { conversationId: channelId }),
    (e) => e.code === "permission_denied" && e.status === 403,
  );
});

test("legacy accepted send keys retain their fingerprint through the new optional literal-text field", async (t) => {
  const f = await contractsFixture(t),
    legacy = new SlackService(f.client, f.dir);
  const input = {
    channel: channelId,
    text: "Existing accepted message",
    idempotencyKey: "legacy-existing-key",
  };
  const prior = await legacy.invoke(
    legacyOperations.find((op) => op.id === "postSlackMessage"),
    input,
    f.connection,
  );
  assert.equal(prior.ok, true);
  const replay = await f
    .invocation()
    .request({
      method: "POST",
      url: "/messages",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify(input),
    });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(
    f.calls.filter((c) => c.method === "chat.postMessage").length,
    1,
  );
});

test("common reactions map emoji, preserve counts and replay safely", async (t) => {
 const f=await contractsFixture(t);f.respond(async method => method.startsWith("reactions.") ? {ok:true} : undefined);
 const projected=projectMessage({ts:rootId,text:"Hi",user:ownId,reactions:[{name:"+1",count:2,users:[ownId]},{name:"custom",count:1,users:[]}]},channelId,ownId);
 assert.deepEqual(projected.reactions,[{emoji:"👍",count:2,me:true},{emoji:":custom:",count:1,me:null}]);
 const input={conversationId:channelId,messageId:rootId,emoji:"👍",remove:false};
 const result=await invoke(f,"messaging.reactions.update",input,f.invocation(f.connection,"reaction-op"));
 assert.equal(result.status,"accepted");
 assert.equal(f.calls.at(-1).method,"reactions.add");
 assert.equal(f.calls.at(-1).args.name,"+1");
});

test("an empty authorized reaction snapshot clears old reactions",()=>{
 const row={ts:rootId,text:"Hi",user:ownId};
 assert.deepEqual(projectMessage(row,channelId,ownId,true).reactions,[]);
 assert.equal(projectMessage(row,channelId,ownId,false).reactions,undefined);
});
