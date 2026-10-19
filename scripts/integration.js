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
  const sourceMethods = manager.service("slack-authentication").authMethods;
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
    "PASS: actual GitHub installer, plugin manager, OAuth callback, proxy, API discovery, refresh persistence and restart; fixture providers only",
  );
} finally {
  await manager?.stop();
  database?.db?.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
