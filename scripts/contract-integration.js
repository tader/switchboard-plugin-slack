// Offline conformance through real core HTTP/SSE routes, proxy and the Slack adapter.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  contractsFixture,
  channelId,
  ownId,
  rootId,
} from "../test/contracts-fixture.js";
import { fail } from "../plugins/slack/lib/errors.js";
const core = process.env.SWITCHBOARD_ROOT;
assert(core, "Set SWITCHBOARD_ROOT to a staged core with shared contracts");
const root = path.resolve(core),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-contract-http-"));
process.env.SWITCHBOARD_DATA_DIR = temp;
process.env.SWITCHBOARD_SHARED_CONTRACTS = "1";
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const database = await load("server/db.ts");
database.initDb();
const { initKey, encrypt } = await load("server/crypto.ts");
initKey();
const { createUser, createToken } = await load("server/users.ts");
const { plugins } = await load("server/plugins/manager.ts");
const { api } = await load("server/routes/connections.ts");
const { collectors, pushSources } = await load("server/contracts/service.ts");
const { validateDefinition } = await load("server/contracts/model.ts");
const cleanup = [],
  f = await contractsFixture({ after: (fn) => cleanup.push(fn) });
validateDefinition(f.service.contracts);
assert.equal((await load("server/config.ts")).config.sharedContracts, true);
assert.equal(
  fs.readFileSync("plugins/slack/lib/messaging-v1.json", "utf8"),
  fs.readFileSync(
    path.join(root, "server/contracts/messaging-v1.json"),
    "utf8",
  ),
  "vendored schema must match the staged core",
);
plugins.services.set("slack", { pluginId: "slack", service: f.service });
const { serve } = createRequire(path.join(root, "package.json"))(
  "@hono/node-server",
);
let ready;
const listening = new Promise((r) => (ready = r));
const server = serve(
  { fetch: api.fetch, hostname: "127.0.0.1", port: 0 },
  ready,
);
await listening;
const base = "http://127.0.0.1:" + server.address().port;
const user = createUser("fixture", "admin"),
  id = "slack-contract-http",
  readonly = "slack-contract-readonly";
const insert = (id, access) =>
  database.run(
    "INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    user.id,
    "slack",
    "oauth",
    id,
    encrypt({ access }),
    encrypt(f.connection.credentials),
    "ok",
    Date.now(),
    Date.now(),
  );
insert(id, "write");
insert(readonly, "read");
const token = createToken(user.id, "contracts", [id]).secret,
  readToken = createToken(user.id, "readonly", [readonly]).secret;
const http = async (
  route,
  body,
  auth = token,
  method = body === undefined ? "GET" : "POST",
) =>
  fetch(base + route, {
    method,
    headers: {
      authorization: "Bearer " + auth,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const call = (operation, args, key, connection = id, auth = token) =>
  http(
    `/connections/${connection}/contracts/v1/call`,
    { operation, arguments: args, ...(key ? { idempotencyKey: key } : {}) },
    auth,
  );
let sub;
try {
  const descriptor = await (
    await http(`/connections/${id}/contracts/v1`)
  ).json();
  assert.deepEqual(descriptor.changes, { native: true, reconciliation: true });
  assert.equal(descriptor.operations.length, 6);
  assert.equal(
    descriptor.operations.find((o) => o.name === "messaging.messages.send")
      .inputConstraints.properties.text.maxLength,
    4000,
  );
  assert.equal(
    descriptor.operations.find((o) => o.name === "messaging.messages.list")
      .inputConstraints.properties.limit.maximum,
    15,
  );
  const listed = await (
    await http("/contracts/v1/connections?category=messaging")
  ).json();
  assert.deepEqual(
    listed.connections.map((c) => c.id),
    [id],
  );
  assert.equal(
    (await http(`/connections/${readonly}/contracts/v1`)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { conversationId: channelId, text: "x" },
        "readonly-send",
        readonly,
        readToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { conversationId: channelId, text: "x".repeat(4001) },
        "oversized",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("messaging.messages.list", {
        conversationId: channelId,
        limit: 16,
      })
    ).status,
    400,
  );
  f.respond(async method => method.startsWith("reactions.") ? {ok:true} : undefined);
  const reaction={conversationId:channelId,messageId:rootId,emoji:"👍",remove:false};
  for(let n=0;n<2;n++){const response=await call("messaging.reactions.update",reaction,"reaction-contract");assert.equal(response.status,200);assert.equal((await response.json()).status,"accepted");}
  assert.equal(f.calls.filter(x=>x.method==="reactions.add").length,1);
  f.respond(async (method) =>
    method === "conversations.history"
      ? {
          messages: [
            {
              ts: rootId,
              text: "PRIVATE-RESTRICTED",
              hidden: true,
              user: ownId,
            },
          ],
          response_metadata: { next_cursor: "retained-next" },
        }
      : undefined,
  );
  const page = await (
    await call("messaging.messages.list", { conversationId: channelId })
  ).json();
  assert.equal(page.coverage.complete, false);
  assert.equal(page.items[0].text, null);
  assert.equal(page.items[0].contentState, "restricted");
  assert.equal(
    (
      await call("messaging.messages.list", {
        conversationId: "C23456789",
        cursor: page.nextCursor,
      })
    ).status,
    409,
  );
  f.respond(undefined);
  const thread = await (
    await call("messaging.messages.list", {
      conversationId: channelId,
      threadId: rootId,
    })
  ).json();
  assert.equal(thread.items[0].threadId, rootId);
  assert.equal(thread.coverage.complete, false);
  const args = { conversationId: channelId, text: "PRIVATE-WRITE" };
  for (let n = 0; n < 2; n++) {
    const r = await call("messaging.messages.send", args, "same-key");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "accepted");
  }
  assert.equal(
    f.calls.filter((c) => c.method === "chat.postMessage").length,
    1,
  );
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { ...args, text: "changed" },
        "same-key",
      )
    ).status,
    409,
  );
  f.respond(async (method) => {
    if (method === "chat.postMessage") throw fail("upstream_unavailable", 502);
  });
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await (
          await call("messaging.messages.send", args, "ambiguous-key")
        ).json()
      ).status,
      "uncertain",
    );
  assert.equal(
    f.calls.filter((c) => c.method === "chat.postMessage").length,
    2,
  );
  f.respond(undefined);
  sub = await (
    await http("/contracts/v1/subscriptions", { connections: [id] })
  ).json();
  assert.equal(
    (
      await http(`/contracts/v1/subscriptions/${sub.id}/activity`, {
        active: true,
      })
    ).status,
    200,
  );
  let r = await http(`/contracts/v1/subscriptions/${sub.id}/refresh`, {
    connectionId: id,
  });
  assert.equal((await r.json()).status, "completed");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    const stream = await fetch(
      base +
        `/contracts/v1/subscriptions/${sub.id}/events?cursor=${sub.cursor}`,
      { headers: { authorization: "Bearer " + token }, signal: abort.signal },
    );
    const reader = stream.body.getReader();
    let buffer = "";
    while (!buffer.includes('"type":"invalidated"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += new TextDecoder().decode(chunk.value);
    }
    assert.ok(buffer.includes('"connectionId":"' + id + '"'));
    assert.ok(!buffer.includes("PRIVATE-"));
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  // Passive streams do not clear an explicit terminal pause or trigger more network work.
  collectors().pauseAuthentication(id);
  const before = f.calls.length;
  r = await http(`/contracts/v1/subscriptions/${sub.id}/refresh`, {
    connectionId: id,
  });
  assert.equal((await r.json()).status, "auth_required");
  assert.equal(f.calls.length, before);
  const content = JSON.stringify(database.all("SELECT * FROM audit_log"));
  assert.ok(!content.includes("PRIVATE-WRITE"));
  assert.ok(
    !JSON.stringify(database.all("SELECT * FROM contract_receipts")).includes(
      "PRIVATE-WRITE",
    ),
  );
  assert.ok(!f.calls.some((c) => c.method === "conversations.mark"));
  console.log(
    "PASS: real core HTTP/SSE, canonical Slack discovery/constraints, scoped reads, partial content, durable send replay/uncertainty, metadata invalidation and auth pause; offline fixture only",
  );
} finally {
  await pushSources().stop();
  await collectors().stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const fn of cleanup) await fn();
  database.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
