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
  console.log(
    "PASS: actual GitHub installer, plugin manager, OAuth callback, proxy, API discovery, refresh persistence and restart; fixture providers only",
  );
} finally {
  await manager?.stop();
  database?.db?.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
