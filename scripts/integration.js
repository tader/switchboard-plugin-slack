import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const root = process.env.SWITCHBOARD_ROOT;
if (!root)
  throw Error(
    "Set SWITCHBOARD_ROOT to a Switchboard checkout with npm dependencies installed.",
  );
const core = path.resolve(root),
  dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "switchboard-slack-integration-"),
  );
process.env.SWITCHBOARD_DATA_DIR = path.join(dir, "data");
process.env.SWITCHBOARD_WATCH_PLUGINS = "false";
process.env.SWITCHBOARD_PUBLIC_URL = "http://localhost:8770";
process.env.SWITCHBOARD_BUILTIN_PLUGINS_DIR = path.join(core, "plugins");
const previewRoot = path.join(dir, "outputs");
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT = previewRoot;
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE = "1";
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_INSTANCE = "slack-fixture";
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH = "slack-fixture";
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR, { recursive: true });
const load = (file) => import(pathToFileURL(path.join(core, file)).href),
  realFetch = globalThis.fetch;
const { scopesFor } = await import("../plugins/slack/lib/auth.js");
const sha = "a".repeat(40),
  archiveRoot = path.join(dir, "archive-root");
fs.mkdirSync(path.join(archiveRoot, "plugins"), { recursive: true });
fs.cpSync("plugins/slack", path.join(archiveRoot, "plugins/slack"), {
  recursive: true,
});
fs.cpSync(
  "plugins/slack-authentication",
  path.join(archiveRoot, "plugins/slack-authentication"),
  { recursive: true },
);
const tar = createRequire(path.join(core, "package.json"))("tar"),
  archive = path.join(dir, "slack.tgz");
await tar.c({ gzip: true, file: archive, cwd: dir }, ["archive-root"]);
const bytes = fs.readFileSync(archive);
let refreshes = 0,
  network = [];
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  network.push(url);
  if (url.startsWith("https://api.github.com/repos/fixture/slack/")) {
    if (url.includes("/releases")) {
      const r = { tag_name: "v1.0.0", published_at: "2026-10-19T00:00:00Z" };
      return Response.json(url.endsWith("/latest") ? r : [r]);
    }
    if (url.includes("/commits/")) return new Response(sha);
    if (url.includes("/tarball/")) return new Response(bytes);
  }
  if (url === "https://slack.com/api/oauth.v2.user.access") {
    const params = new URLSearchParams(opts.body);
    assert(new Headers(opts.headers).get("authorization").startsWith("Basic "));
    if (params.get("grant_type") === "refresh_token") refreshes++;
    else assert.equal(params.get("code"), "fixture-code");
    return Response.json({
      ok: true,
      access_token: "fixture-access-" + refreshes,
      refresh_token: "fixture-refresh-" + refreshes,
      expires_in: 3600,
      token_type: "user",
      authed_user: { id: "U12345678", scope: scopesFor("write").join(",") },
      team: { id: "T12345678" },
    });
  }
  if (url === "https://slack.com/api/auth.test")
    return Response.json({
      ok: true,
      team_id: "T12345678",
      user_id: "U12345678",
      team: "Fixture",
      user: "fixture",
    });
  if (url === "https://slack.com/api/conversations.history")
    return Response.json({
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "next-page" },
    });
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, opts);
  throw Error("Unexpected network destination: " + new URL(url).hostname);
};
let manager, database;
try {
  const crypto = await load("server/crypto.ts");
  database = await load("server/db.ts");
  crypto.initKey();
  database.initDb();
  manager = (await load("server/plugins/manager.ts")).plugins;
  await manager.start();
  const user = (await load("server/users.ts")).createUser(
    "slack-integration",
    "admin",
  );
  await (
    await load("server/plugins/github.ts")
  ).install(
    { repo: "fixture/slack", path: "plugins/slack-authentication" },
    { user },
  );
  assert.equal(manager.get("slack-authentication").status, "active");
  await (
    await load("server/plugins/github.ts")
  ).install({ repo: "fixture/slack", path: "plugins/slack" }, { user });
  assert.equal(manager.get("slack").status, "active");
  assert.equal(manager.get("slack").source.commit, sha);
  await manager.saveSettings("slack", {
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
  });
  const connections = await load("server/connections.ts"),
    flow = await connections.startConnect(user, {
      service: "slack",
      method: "oauth",
      config: { access: "write" },
    });
  assert.equal(flow.status, "redirect");
  const connection = await connections.completeRedirect(
    flow.flowId,
    { state: flow.flowId, code: "fixture-code" },
    user,
  );
  const { execute } = await load("server/proxy.ts");
  const output = await load("server/activity-output.ts");
  const { openPreviewStore } = await load("shared/activity-preview-store.ts");
  openPreviewStore(previewRoot, [process.env.SWITCHBOARD_DATA_DIR], "slack-fixture");
  const { config } = await load("server/config.ts");
  config.previewStoreId = JSON.parse(
    fs.readFileSync(path.join(previewRoot, "store.json"), "utf8"),
  ).storeId;
  output.initOutputStore();
  assert.equal(output.outputCaptureAvailability().available, true);
  output.setOutputRetention(4);

  const caller = {
    source: "proxy",
    tokenId: null,
    tokenName: null,
    ip: null,
    userAgent: null,
  };
  const projected = { nativeUnreadCoverage: "only_where_returned" };
  const audited = async (
    id,
    { url = "/capabilities", method = "GET", reply, requests = 1 } = {},
  ) => {
    const origin = manager.service("slack").outputPreviews[0].origin;
    const fetch = globalThis.fetch;
    let upstream;
    let count = 0;
    globalThis.fetch = async (input, opts) => {
      if (String(input).startsWith("http://127.0.0.1:")) {
        assert.equal(new URL(input).origin, origin);
        count++;
        const response = reply ? reply(opts, count) : await fetch(input, opts);
        if (count === requests) upstream = response.clone();
        return response;
      }
      return fetch(input, opts);
    };
    try {
      const result = await execute(user, id, { method, url }, undefined, caller);
      assert.ok(result.auditId);
      assert.equal(count, requests);
      assert.equal(result.response.status, upstream.status);
      assert.deepEqual([...result.response.headers], [...upstream.headers]);
      const body = Buffer.from(await result.response.arrayBuffer());
      assert.deepEqual(body, Buffer.from(await upstream.arrayBuffer()));
      const recorded = output.readOutput(user.id, result.auditId, true);
      assert.equal(output.readOutput(user.id, result.auditId, false).preview, undefined);
      return { body, ...recorded };
    } finally {
      globalThis.fetch = fetch;
    }
  };

  const checkCapabilities = async (id, authentication, scopes) => {
    const before = network.length;
    const result = await audited(id);
    assert.equal(network.length, before + 1, "capabilities only calls loopback");
    const body = JSON.parse(result.body);
    assert.equal(body.authentication, authentication);
    assert.equal(body.workspace, "T12345678");
    assert.equal(body.user, "U12345678");
    assert.deepEqual(body.scopes, scopes);
    assert.deepEqual(result.preview, projected);
  };

  const firstOrigin = manager.service("slack").outputPreviews[0].origin;
  await checkCapabilities(connection.id, "oauth", scopesFor("write"));
  for (const options of [
    { url: "/status", reply: () => Response.json(projected) },
    { url: "/capabilities?unexpected=true" },
    { url: "/capabilities?unexpected=true", reply: () => Response.json(projected) },
    { method: "HEAD" },
    { reply: (opts) => Response.json({
      nativeUnreadCoverage: new Headers(opts.headers).get("authorization").slice(7),
    }) },
    { reply: () => Response.json({ nativeUnreadCoverage: "é".repeat(17) }) },
    { reply: () => Response.json(projected, { status: 503 }) },
    { reply: () => new Response(null, { status: 204 }) },
    { reply: () => new Response(JSON.stringify(projected)) },
    { reply: () => Response.json({ nested: projected }) },
    { reply: () => new Response("{", { headers: { "content-type": "application/json" } }) },
  ]) {
    assert.equal((await audited(connection.id, options)).state, "omitted");
  }
  const emptySize = Buffer.byteLength(JSON.stringify({ ...projected, padding: "" }));
  for (const size of [16_384, 16_385]) {
    const { preview } = await audited(connection.id, {
      reply: () => Response.json({
        ...projected,
        padding: "x".repeat(size - emptySize),
      }),
    });
    assert.deepEqual(preview, size === 16_384 ? projected : undefined);
  }
  output.setOutputRetention(0);
  assert.equal((await audited(connection.id)).state, "disabled");
  assert.equal(database.one("SELECT count(*) AS count FROM audit_outputs").count, 0);
  output.setOutputRetention(4);
  config.previewRestoreSafe = false;
  output.initOutputStore();
  assert.equal((await audited(connection.id)).state, "omitted");
  config.previewRestoreSafe = true;
  output.initOutputStore();
  let r = await execute(user, connection.id, { method: "GET", url: "/status" });
  assert.equal(r.response.status, 200);
  assert.equal((await r.response.json()).ready, true);
  r = await execute(user, connection.id, {
    method: "GET",
    url: "/messages",
    query: [["channel", "C12345678"]],
  });
  assert.equal((await r.response.json()).nextCursor, "next-page");
  r = await execute(user, connection.id, {
    method: "GET",
    url: "/status?renew=true",
  });
  assert.equal((await r.response.json()).ready, true);
  assert.equal(refreshes, 1);
  const stored = database.one(
    "select credentials_enc from connections where id=?",
    connection.id,
  ).credentials_enc;
  assert(!stored.includes("fixture-access"));
  assert.equal(crypto.decrypt(stored).refreshToken, "fixture-refresh-1");
  const description = await (
    await load("server/openapi.ts")
  ).describe(
    manager.service("slack"),
    connections.loadConnection(user.id, connection.id).conn,
  );
  assert(description.operations.some((op) => op.id === "replySlackBatch"));
  await manager.stop();
  await manager.start();
  assert.equal(manager.get("slack").status, "active");
  r = await execute(user, connection.id, { method: "GET", url: "/" });
  assert.equal((await r.response.json()).ready, true);
  assert.equal(refreshes, 1, "restart reuses the persisted session");
  const sourceId = "fixture-slack-source",
    webBundle = {
      kind: "web",
      accessToken: "xoxc-fixture-web-session",
      cookie: "xoxd-fixture-session-cookie",
      userAgent: "fixture-agent",
      teamId: "T12345678",
      userId: "U12345678",
      validatedAt: Date.now(),
    };
  database.run(
    `INSERT INTO connections (id,user_id,service_id,method_id,name,account_id,account_label,config_enc,credentials_enc,created_at,updated_at,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    sourceId,
    user.id,
    "slack-authentication",
    "browser",
    "fixture-slack-source",
    "T12345678:U12345678",
    "Fixture",
    crypto.encrypt({ workspaceUrl: "https://fixture.slack.com/" }),
    crypto.encrypt({
      profile: "00000000-0000-4000-8000-000000000000",
      selected: {
        host: "fixture.slack.com",
        url: "https://fixture.slack.com/",
      },
      bundle: webBundle,
    }),
    Date.now(),
    Date.now(),
    "http",
  );
  r = await execute(user, sourceId, { method: "GET", url: "/" });
  assert.equal(
    r.response.status,
    200,
    "source root health check uses identity only",
  );
  assert.equal((await r.response.json()).ok, true);
  const webFlow = await connections.startConnect(user, {
    service: "slack",
    method: "authentication-source",
    config: { authenticationSource: sourceId, access: "read" },
  });
  assert.equal(webFlow.status, "connected");
  assert.notEqual(manager.service("slack").outputPreviews[0].origin, firstOrigin);
  await checkCapabilities(connection.id, "oauth", scopesFor("write"));
  await checkCapabilities(webFlow.connection.id, "web-session", []);
  assert.equal((await audited(webFlow.connection.id, {
    reply: () => Response.json({ nativeUnreadCoverage: webBundle.cookie }),
  })).state, "omitted");
  const retry = await audited(connection.id, {
    requests: 2,
    reply: (_, count) => count === 1
      ? Response.json({ error: "retry" }, { status: 401 })
      : Response.json(projected),
  });
  assert.deepEqual(retry.preview, projected);
  r = await execute(user, webFlow.connection.id, {
    method: "GET",
    url: "/status?renew=true",
  });
  assert.equal((await r.response.json()).ready, true);
  const encrypted = database.one(
    "SELECT credentials_enc FROM connections WHERE id=?",
    webFlow.connection.id,
  ).credentials_enc;
  assert(!encrypted.includes("xoxc-"));
  assert(!encrypted.includes("xoxd-"));
  assert.equal(crypto.decrypt(encrypted).cookie, webBundle.cookie);
  await manager.stop();
  await manager.start();
  r = await execute(user, webFlow.connection.id, {
    method: "GET",
    url: "/status",
  });
  assert.equal((await r.response.json()).ready, true);
  // Observed removal of a source prevents use of even still-valid cached credentials.
  database.run("DELETE FROM connections WHERE id=?", sourceId);
  await assert.rejects(
    execute(user, webFlow.connection.id, { method: "GET", url: "/status" }),
  );
  const sourceService = manager.service("slack-authentication");
  assert.equal(sourceService.outputPreviews, undefined);
  const sourceMethods = sourceService.authMethods;
  assert(
    sourceMethods.some(
      (m) =>
        m.id === "desktop" &&
        m.credentialProvider.format === "slack/web-session/v1",
    ),
  );
  assert(
    manager
      .service("slack")
      .authMethods.some(
        (m) =>
          m.id === "authentication-source" &&
          m.credentialConsumer.field === "authenticationSource",
      ),
  );
  console.log(
    "PASS: actual GitHub installer, plugin manager, OAuth callback, proxy, activity previews, API discovery, refresh persistence and restart; fixture providers only",
  );
} finally {
  await manager?.stop();
  database?.db?.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
