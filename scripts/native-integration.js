// Native Socket Mode publication through real core HTTP/SSE; no live provider calls.
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
const sockets = [],
  nativeRequests = [];
const until = async (predicate) => {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Native fixture condition timed out");
    await new Promise((r) => setImmediate(r));
  }
};
class Socket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
  }
  send(text) {
    const ack = JSON.parse(text);
    const rows = database.all(
      "SELECT * FROM contract_events WHERE connection=? AND source_id=?",
      id,
      "slack-event:EvActual1",
    );
    if (ack.envelope_id === "event-1")
      assert.equal(rows.length, 1, "ACK must follow durable commit");
    this.sent.push(ack);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  emit(frame) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }
}
const settings = {
  socketMode: true,
  socketAppId: "A12345678",
  socketAppToken: "xapp-Private0123456789",
};
const cleanup = [],
  f = await contractsFixture(
    { after: (fn) => cleanup.push(fn) },
    {
      settings,
      socketOptions: {
        refreshDelayMs: 0,
        createSocket: () => {
          const socket = new Socket();
          sockets.push(socket);
          return socket;
        },
        fetcher: async (url, args) => {
          nativeRequests.push(url);
          return new Response(
            JSON.stringify(
              url.endsWith("open")
                ? {
                    ok: true,
                    url: "wss://wss-primary.slack.com/link/?ticket=PRIVATE",
                  }
                : {
                    ok: true,
                    authorizations: [
                      { team_id: "T12345678", user_id: ownId, is_bot: false },
                    ],
                  },
            ),
          );
        },
      },
    },
  );
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
const hello = (socket) =>
  socket.emit({
    type: "hello",
    connection_info: { app_id: settings.socketAppId },
  });
const envelope = {
  type: "events_api",
  envelope_id: "event-1",
  payload: {
    type: "event_callback",
    api_app_id: settings.socketAppId,
    event_id: "EvActual1",
    event_context: "context-1",
    team_id: "T12345678",
    event: { type: "message", text: "PRIVATE-NATIVE-BODY", channel: channelId },
    authorizations: [{ team_id: "T12345678", user_id: ownId, is_bot: false }],
  },
};
try {
  const descriptor = await (
    await http(`/connections/${id}/contracts/v1`)
  ).json();
  assert.deepEqual(descriptor.changes, { native: true, reconciliation: true });
  sub = await (
    await http("/contracts/v1/subscriptions", { connections: [id] })
  ).json();
  await http(`/contracts/v1/subscriptions/${sub.id}/activity`, {
    active: true,
  });
  await pushSources().tick();
  await until(() => sockets.length === 1);
  hello(sockets[0]);
  sockets[0].emit(envelope);
  await until(() => sockets[0].sent.length === 1);
  assert.equal(
    database.one(
      "SELECT cursor FROM contract_push_checkpoints WHERE connection=?",
      id,
    ).cursor,
    "slack-event:EvActual1",
  );
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 3000);
  try {
    const res = await fetch(
      base +
        `/contracts/v1/subscriptions/${sub.id}/events?cursor=${sub.cursor}`,
      { headers: { authorization: "Bearer " + token }, signal: abort.signal },
    );
    const reader = res.body.getReader();
    let body = "";
    try {
      while (!body.includes('"type":"invalidated"')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        body += new TextDecoder().decode(chunk.value);
      }
      assert.ok(!body.includes("PRIVATE"));
      assert.ok(body.includes('"connectionId":"' + id + '"'));
    } finally {
      await reader.cancel();
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  database.run(
    "UPDATE contract_subscriptions SET active_until=0,poll_until=0 WHERE id=?",
    sub.id,
  );
  await pushSources().tick();
  await until(() => sockets[0].closed);
  const before = nativeRequests.length;
  await pushSources().tick();
  assert.equal(nativeRequests.length, before);
  await http(`/contracts/v1/subscriptions/${sub.id}/activity`, {
    active: true,
  });
  await pushSources().tick();
  await until(() => sockets.length === 2);
  hello(sockets[1]);
  sockets[1].emit(envelope);
  await until(() => sockets[1].sent.length === 1);
  assert.equal(
    database.all(
      "SELECT * FROM contract_events WHERE connection=? AND source_id=?",
      id,
      "slack-event:EvActual1",
    ).length,
    1,
    "Provider retry deduplicates after native receiver restart",
  );
  f.respond((method) => {
    if (method === "auth.test") throw fail("token_expired", 401);
  });
  assert.equal(
    (
      await (
        await http(`/contracts/v1/subscriptions/${sub.id}/refresh`, {
          connectionId: id,
        })
      ).json()
    ).status,
    "auth_required",
  );
  await pushSources().tick();
  await until(() => sockets[1].closed);
  const paused = nativeRequests.length;
  await pushSources().tick();
  assert.equal(nativeRequests.length, paused);
  assert.equal(collectors().state(id).status, "auth_required");
  for (const table of [
    "contract_events",
    "contract_push_checkpoints",
    "contract_receipts",
    "audit_log",
  ])
    assert.ok(
      !JSON.stringify(database.all("SELECT * FROM " + table)).includes(
        "PRIVATE",
      ),
    );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.method === "chat.postMessage" || c.method === "conversations.mark",
    ),
  );
  console.log(
    "PASS: Slack native Socket Mode -> durable metadata/checkpoint -> HTTP/SSE, post-commit ACK, dedupe after receiver restart, idle expiry and terminal user-auth stop; offline only",
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
