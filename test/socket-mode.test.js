import test from "node:test";
import assert from "node:assert/strict";
import { SocketMode } from "../plugins/slack/lib/socket-mode.js";
const settings = {
  socketMode: true,
  socketAppId: "A12345678",
  socketAppToken: "xapp-Private0123456789",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Fixture condition timed out");
    await tick();
  }
}
class Socket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = 0;
    this.listeners = new Set();
  }
  addEventListener(type, fn, options) {
    this.listeners.add(fn);
    super.addEventListener(type, fn, options);
  }
  removeEventListener(type, fn, options) {
    this.listeners.delete(fn);
    super.removeEventListener(type, fn, options);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  emit(frame) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }
  close() {
    this.closed++;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
const hello = (s) =>
  s.emit({ type: "hello", connection_info: { app_id: settings.socketAppId } });
const event = (id = "Ev1", extra = {}) => ({
  type: "events_api",
  envelope_id: "envelope-" + id,
  payload: {
    type: "event_callback",
    api_app_id: settings.socketAppId,
    event_id: id.startsWith("Ev") ? id : "Ev" + id,
    event_context: "context-" + id,
    team_id: "T12345678",
    authorizations: [
      { team_id: "T12345678", user_id: "U12345678", is_bot: false },
    ],
    event: {
      type: "message",
      channel: "CPRIVATE",
      text: "PRIVATE BODY SHOULD NEVER BE STORED",
    },
    ...extra,
  },
});
function fixture(t, { fetcher, publish, refreshDelayMs = 0 } = {}) {
  const sockets = [],
    requests = [],
    members = [];
  const hub = new SocketMode(settings, {
    refreshDelayMs,
    createSocket: () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
    fetcher: async (url, args) => {
      requests.push({ url, args });
      if (fetcher) return fetcher(url, args);
      return new Response(
        JSON.stringify(
          url.endsWith("apps.connections.open")
            ? {
                ok: true,
                url: "wss://wss-primary.slack.com/link/?ticket=PRIVATE-TICKET",
              }
            : {
                ok: true,
                authorizations: [
                  { team_id: "T12345678", user_id: "U12345678", is_bot: false },
                  { team_id: "T12345678", user_id: "U87654321", is_bot: false },
                ],
              },
        ),
      );
    },
  });
  function watch(user = "U12345678", team = "T12345678") {
    const controller = new AbortController(),
      batches = [],
      member = { controller, batches, error: undefined, settled: false };
    members.push(member);
    member.promise = hub
      .watch(
        {},
        {
          connection: {
            id: "c" + members.length,
            credentials: { teamId: team, userId: user },
          },
          signal: controller.signal,
          async publish(batch) {
            if (publish) await publish(member, batch);
            batches.push(structuredClone(batch));
          },
        },
      )
      .catch((e) => {
        member.error = e;
      })
      .finally(() => {
        member.settled = true;
      });
    return member;
  }
  t.after(async () => {
    for (const m of members) m.controller.abort();
    await hub.dispose();
    await Promise.all(members.map((m) => m.promise));
  });
  return { hub, sockets, requests, watch };
}
const changes = (m) =>
  m.batches.filter((b) => b.events[0].event.type === "invalidated");
test("Socket Mode is explicitly opt-in and never contacts Slack when unconfigured", async () => {
  const hub = new SocketMode(
    {},
    {
      fetcher: () => {
        throw Error("must not fetch");
      },
    },
  );
  assert.equal(hub.configured(), false);
  await assert.rejects(() => hub.watch({}, {}), {
    code: "watch_not_supported",
  });
});
test("one app socket fans out using complete installation authorizations, never message bodies", async (t) => {
  const f = fixture(t),
    a = f.watch(),
    b = f.watch("U87654321"),
    other = f.watch("U87654321", "TOTHER1234");
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit(event());
  await until(() => f.sockets[0].sent.length === 1);
  assert.equal(f.sockets.length, 1);
  assert.equal(changes(a).length, 1);
  assert.equal(changes(b).length, 1);
  assert.equal(changes(other).length, 0);
  assert.ok(
    f.requests.some((r) => r.url.endsWith("apps.event.authorizations.list")),
  );
  assert.ok(
    f.requests.every(
      (r) =>
        r.args.headers.authorization === "Bearer " + settings.socketAppToken,
    ),
  );
  const serialized = JSON.stringify([a.batches, b.batches]);
  assert.ok(!serialized.includes("PRIVATE"));
  assert.ok(!serialized.includes("CPRIVATE"));
  assert.ok(!serialized.includes(settings.socketAppToken));
  assert.deepEqual(f.sockets[0].sent, [{ envelope_id: "envelope-Ev1" }]);
});
test("acknowledgement follows durable publications for every relevant active connection", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let entered = false;
  const f = fixture(t, {
      publish: async (member, batch) => {
        if (batch.events[0].event.type === "invalidated") {
          entered = true;
          await gate;
        }
      },
    }),
    a = f.watch();
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit(event());
  await until(() => entered);
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(changes(a).length, 0);
  release();
  await until(() => f.sockets[0].sent.length === 1);
  assert.equal(changes(a).length, 1);
});
test("authorizations are fully paginated; bot installs and other workspaces are not user authorizations", async (t) => {
  let pages = 0;
  const f = fixture(t, {
      fetcher: async (url, args) =>
        new Response(
          JSON.stringify(
            url.endsWith("open")
              ? { ok: true, url: "wss://wss-primary.slack.com/link/" }
              : ++pages === 1
                ? {
                    ok: true,
                    authorizations: [
                      {
                        team_id: "T12345678",
                        user_id: "U12345678",
                        is_bot: true,
                      },
                    ],
                    response_metadata: { next_cursor: "second" },
                  }
                : {
                    ok: true,
                    authorizations: [
                      {
                        team_id: "T12345678",
                        user_id: "U87654321",
                        is_bot: false,
                      },
                    ],
                  },
          ),
        ),
    }),
    a = f.watch(),
    b = f.watch("U87654321");
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit(event());
  await until(() => f.sockets[0].sent.length === 1);
  assert.equal(pages, 2);
  assert.equal(changes(a).length, 0);
  assert.equal(changes(b).length, 1);
});
test("events without context use only explicitly listed non-bot installations", async (t) => {
  const f = fixture(t),
    a = f.watch(),
    b = f.watch("U87654321");
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit(event("NoContext", { event_context: undefined }));
  await until(() => f.sockets[0].sent.length === 1);
  assert.equal(changes(a).length, 1);
  assert.equal(changes(b).length, 0);
  assert.equal(f.requests.length, 1);
});
test("one failed publication is not acknowledged or allowed to stop other users", async (t) => {
  const f = fixture(t, {
      publish: async (member, batch) => {
        if (member === a && batch.events[0].event.type === "invalidated")
          throw Error("commit refused");
      },
    }),
    a = f.watch(),
    b = f.watch("U87654321");
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit(event());
  await until(() => a.settled);
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(changes(b).length, 1);
  assert.equal(b.settled, false);
  f.sockets[0].emit(event("Retry"));
  await until(() => f.sockets[0].sent.length === 1);
  assert.equal(changes(b).length, 2);
});
test("last inactive consumer closes the socket and removes listeners; another active user keeps it alive", async (t) => {
  const f = fixture(t),
    a = f.watch(),
    b = f.watch("U87654321");
  await until(() => f.sockets.length === 1);
  const s = f.sockets[0];
  hello(s);
  await until(() => a.batches.length === 2);
  a.controller.abort();
  await a.promise;
  assert.equal(s.closed, 0);
  b.controller.abort();
  await b.promise;
  assert.equal(s.closed, 1);
  assert.equal(s.listeners.size, 0);
  assert.equal(f.hub.members.size, 0);
});
test("scheduled connection refresh replaces the single socket and forces resync", async (t) => {
  const f = fixture(t),
    a = f.watch();
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit({ type: "disconnect", reason: "refresh_requested" });
  await until(() => f.sockets.length === 2);
  assert.equal(f.sockets[0].closed, 1);
  assert.equal(f.sockets[0].listeners.size, 0);
  hello(f.sockets[1]);
  await until(() => a.batches.length === 3);
  assert.equal(a.batches[2].events[0].event.type, "resync.required");
  assert.equal(a.settled, false);
});
test("app-token failure is unsupported push, not user authentication failure", async (t) => {
  const f = fixture(t, {
      fetcher: async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 403,
        }),
    }),
    a = f.watch();
  await until(() => a.settled);
  assert.equal(a.error.code, "watch_not_supported");
  assert.equal(a.error.status, 501);
  assert.equal(a.error.reauthenticationRequired, undefined);
  assert.equal(f.sockets.length, 0);
});
test("app-level rate limit preserves backoff without pausing user credentials", async (t) => {
  const f = fixture(t, {
      fetcher: async () =>
        new Response("", { status: 429, headers: { "retry-after": "120" } }),
    }),
    a = f.watch();
  await until(() => a.settled);
  assert.equal(a.error.code, "native_rate_limited");
  assert.equal(a.error.retryAfterMs, 120000);
  assert.equal(a.error.status, 503);
});
test("foreign websocket endpoints and mismatched app hello cannot leak credentials or receive events", async (t) => {
  const bad = fixture(t, {
      fetcher: async () =>
        new Response(
          JSON.stringify({ ok: true, url: "wss://evil.example/link/" }),
        ),
    }),
    a = bad.watch();
  await until(() => a.settled);
  assert.equal(a.error.code, "native_endpoint_invalid");
  assert.equal(bad.sockets.length, 0);
  const f = fixture(t),
    b = f.watch();
  await until(() => f.sockets.length === 1);
  f.sockets[0].emit({
    type: "hello",
    connection_info: { app_id: "AOTHER123" },
  });
  await until(() => b.settled);
  assert.equal(b.error.code, "native_app_mismatch");
  assert.equal(f.sockets[0].closed, 1);
  assert.equal(f.sockets[0].sent.length, 0);
});
test("abort during app connection creation cancels in-flight HTTP and completes watch", async (t) => {
  let signal;
  const f = fixture(t, {
      fetcher: (_url, args) => {
        signal = args.signal;
        return new Promise((resolve, reject) =>
          args.signal.addEventListener(
            "abort",
            () => reject(args.signal.reason),
            { once: true },
          ),
        );
      },
    }),
    a = f.watch();
  await until(() => signal);
  a.controller.abort();
  await a.promise;
  assert.equal(signal.aborted, true);
  assert.equal(f.sockets.length, 0);
});

test("oversized ingress closes without acknowledgement or retained body", async (t) => {
  const f = fixture(t),
    a = f.watch();
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].dispatchEvent(
    new MessageEvent("message", { data: "x".repeat(1024 * 1024 + 1) }),
  );
  await until(() => a.settled);
  assert.equal(a.error.code, "native_payload_invalid");
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(f.sockets[0].listeners.size, 0);
});

test("incomplete authorization traversal never acknowledges an event", async (t) => {
  let pages = 0;
  const f = fixture(t, {
      fetcher: async (url) =>
        new Response(
          JSON.stringify(
            url.endsWith("open")
              ? { ok: true, url: "wss://wss-primary.slack.com/link/" }
              : {
                  ok: true,
                  authorizations: [],
                  response_metadata: { next_cursor: "page-" + ++pages },
                },
          ),
        ),
    }),
    a = f.watch();
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit(event("Ev1", { authorizations: [] }));
  await until(() => a.settled);
  assert.equal(a.error.code, "native_authorizations_bounded");
  assert.equal(pages, 20);
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(changes(a).length, 0);
});

test("a disabled Socket Mode link backs off rather than reconnecting in a tight loop", async (t) => {
  const f = fixture(t),
    a = f.watch();
  await until(() => f.sockets.length === 1);
  hello(f.sockets[0]);
  await until(() => a.batches.length === 2);
  f.sockets[0].emit({ type: "disconnect", reason: "link_disabled" });
  await until(() => a.settled);
  assert.equal(a.error.code, "native_socket_disabled");
  assert.equal(f.sockets.length, 1);
});

test("another app receiver is detected before claiming native coverage", async (t) => {
  const f = fixture(t),
    a = f.watch();
  await until(() => f.sockets.length === 1);
  f.sockets[0].emit({
    type: "hello",
    connection_info: { app_id: settings.socketAppId },
    num_connections: 2,
  });
  await until(() => a.settled);
  assert.equal(a.error.code, "native_shared_app_socket");
  assert.equal(f.sockets[0].closed, 1);
});
