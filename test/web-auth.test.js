import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCipheriv, pbkdf2Sync, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  decryptCookie,
  extractTokens,
  importDesktop,
} from "../plugins/slack-authentication/lib/desktop.js";
import {
  requestToken,
  captureBrowser,
} from "../plugins/slack-authentication/lib/browser.js";
import {
  FORMAT,
  candidate,
  workspace,
  identify,
  validateBundle,
} from "../plugins/slack-authentication/lib/session.js";
import { setupProvider } from "../plugins/slack-authentication/lib/provider.js";
import { createAuth } from "../plugins/slack/lib/auth.js";
import { SlackClient } from "../plugins/slack/lib/client.js";
import { SlackService } from "../plugins/slack/lib/service.js";
import { operations } from "../plugins/slack/lib/operations.js";
import { oauthFixture, context } from "./fixture.js";
const token = "xoxc-fixture-session-token",
  cookie = "xoxd-fixture-session-cookie";
const bundle = () => ({
  ...candidate(token, cookie, "fixture-agent"),
  teamId: "T12345678",
  userId: "U12345678",
  validatedAt: Date.now(),
});
const account = { id: "T12345678:U12345678", label: "Fixture" };
const response = {
  ok: true,
  team_id: "T12345678",
  user_id: "U12345678",
  url: "https://fixture.slack.com/",
  user: "fixture",
  team: "Fixture",
};
const selected = workspace("https://fixture.slack.com/");
test("web session headers are limited to Slack API and OAuth never includes a cookie", async () => {
  const calls = [];
  const client = new SlackClient(async (url, opts) => {
    calls.push({ url, opts });
    return Response.json(response);
  });
  await client.call(bundle(), "auth.test");
  assert.equal(calls[0].opts.headers.cookie, `d=${cookie}`);
  assert.equal(calls[0].opts.headers["user-agent"], "fixture-agent");
  await client.call({ accessToken: "official-oauth" }, "auth.test");
  assert.equal(calls[1].opts.headers.cookie, undefined);
  await assert.rejects(
    client.call(
      { ...bundle(), cookie: cookie + "; other=secret" },
      "auth.test",
    ),
    { code: "invalid_session" },
  );
  await assert.rejects(client.call(bundle(), "https://attacker.invalid"), {
    code: "unsupported_method",
  });
});
test("workspace binding and session validation reject other origins/accounts and header injection", async () => {
  for (const url of [
    "http://fixture.slack.com",
    "https://slack.com",
    "https://slack.com.attacker.invalid",
    "https://user@fixture.slack.com",
    "https://app.slack.com/client/invalid",
  ])
    assert.throws(() => workspace(url));
  assert.equal(
    workspace("https://app.slack.com/client/T12345678/C123").teamId,
    "T12345678",
  );
  assert.throws(() =>
    validateBundle({ ...bundle(), userAgent: "bad\r\nCookie: secret" }),
  );
  assert.throws(
    () => validateBundle(bundle(), { teamId: "TOTHER", userId: "U12345678" }),
    { code: "account_mismatch" },
  );
  const result = await identify(bundle(), {
    selected,
    fetcher: async () => Response.json(response),
  });
  assert.equal(result.account.id, account.id);
  await assert.rejects(
    identify(bundle(), {
      selected: { host: "other.slack.com" },
      fetcher: async () => Response.json(response),
    }),
    { code: "workspace_mismatch" },
  );
  await assert.rejects(
    identify(bundle(), {
      fetcher: async () => Response.json({ ok: false, error: "invalid_auth" }),
    }),
    { code: "invalid_auth" },
  );
});
test("network capture accepts only Slack API token metadata, including form and JSON", () => {
  for (const postData of [
    JSON.stringify({ token }),
    new URLSearchParams({ token }).toString(),
  ])
    assert.equal(
      requestToken({
        url: "https://fixture.slack.com/api/client.counts",
        postData,
      }),
      token,
    );
  assert.equal(
    requestToken({
      url: "https://app.slack.com/api/auth.test",
      headers: { Authorization: `Bearer ${token}` },
    }),
    token,
  );
  for (const url of [
    "https://attacker.invalid/api/auth.test",
    "https://slack.com.attacker.invalid/api/auth.test",
    "https://fixture.slack.com/messages",
    "http://fixture.slack.com/api/auth.test",
  ])
    assert.equal(
      requestToken({ url, headers: { Authorization: `Bearer ${token}` } }),
      undefined,
    );
});
test("desktop cookie decryption supports host-bound Chromium schema and never modifies the desktop database", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "slack-desktop-fixture-"),
  );
  try {
    const root = path.join(dir, "Library/Application Support/Slack");
    await fs.mkdir(path.join(root, "Local Storage/leveldb"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "Local Storage/leveldb/000001.log"),
      Buffer.from(`binary\0${token}\0`),
    );
    const password = "fixture-keychain-key",
      host = ".slack.com";
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"),
      cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    const encrypted = Buffer.concat([
      Buffer.from("v10"),
      cipher.update(
        Buffer.concat([
          createHash("sha256").update(host).digest(),
          Buffer.from(cookie),
        ]),
      ),
      cipher.final(),
    ]);
    assert.equal(decryptCookie(encrypted, password, host, 24), cookie);
    assert.throws(() => decryptCookie(encrypted, password, "wrong", 24));
    const file = path.join(root, "Cookies"),
      db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,expires_utc INTEGER);CREATE TABLE meta(key TEXT,value TEXT);",
    );
    db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?)").run(
      host,
      "d",
      "",
      encrypted,
      999,
    );
    db.prepare("INSERT INTO meta VALUES(?,?)").run("version", "24");
    db.close();
    const before = await fs.readFile(file);
    let keychainCalls = 0;
    const result = await importDesktop(selected, {
      platform: "darwin",
      home: dir,
      execute: async (exe, args) => {
        keychainCalls++;
        assert.equal(exe, "/usr/bin/security");
        assert.deepEqual(args, [
          "find-generic-password",
          "-s",
          "Slack Safe Storage",
          "-w",
        ]);
        return { stdout: password + "\n" };
      },
      verify: async (c, opts) => {
        assert.equal(c.cookie, cookie);
        assert.equal(c.accessToken, token);
        assert.deepEqual(opts.selected, selected);
        return { credentials: bundle(), account };
      },
    });
    assert.equal(result.account.id, account.id);
    assert.equal(keychainCalls, 1);
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(extractTokens(Buffer.from(token + " " + token)), [token]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("provider caches sessions, silently reacquires only rejected sessions and binds reconnect account", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-provider-"));
  let imports = 0,
    reject = false;
  const provider = setupProvider(
    { dataDir: dir, settings: {} },
    {
      desktop: async () => {
        imports++;
        return { credentials: bundle(), account };
      },
      verify: async () => {
        if (reject)
          throw Object.assign(new Error("invalid_auth"), { status: 401 });
        return { credentials: bundle(), account };
      },
    },
  );
  try {
    const desktop = provider.services[0].authMethods.find(
      (m) => m.id === "desktop",
    );
    const flow = await desktop.connect({
      config: { workspaceUrl: selected.url },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const result = await desktop.poll({ pending: flow.pending });
    assert.equal(imports, 1);
    const conn = { methodId: "desktop", credentials: result.credentials };
    const cached = await desktop.credentialProvider.provide(conn, {});
    assert.equal(imports, 1);
    assert.equal(cached.bundle.cookie, cookie);
    reject = true;
    const next = await desktop.credentialProvider.provide(conn, {
      persistCredentials: () => {},
    });
    assert.equal(imports, 2);
    assert.equal(next.account.id, account.id);
    await assert.rejects(
      desktop.authorize(
        {
          method: "GET",
          url: new URL("https://slack.com/api/conversations.history"),
        },
        conn,
      ),
      { code: "request_forbidden" },
    );
  } finally {
    provider.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("consumer exposes source picker, needs no OAuth app, and uses current source before forced import", async () => {
  const requests = [];
  let valid = true;
  const client = {
    call: async () => {
      if (!valid)
        throw Object.assign(new Error("invalid_auth"), { status: 401 });
      return response;
    },
  };
  const ctx = {
    ...context(oauthFixture()),
    settings: {},
    credentials: {
      obtain: async (ref, opts) => {
        requests.push(opts.forceAuthentication);
        assert.equal(ref, "source");
        if (opts.forceAuthentication) valid = true;
        return { format: FORMAT, bundle: bundle(), account };
      },
    },
  };
  const auth = createAuth(ctx, client),
    method = auth.methods[0];
  assert.equal(method.credentialConsumer.field, "authenticationSource");
  assert.equal(method.fields.at(-1).type, "credential-source");
  const result = await method.connect({
    config: { authenticationSource: "source", access: "read" },
  });
  assert.deepEqual(requests, [false]);
  const conn = {
    ...result,
    credentials: { ...result.credentials, validatedAt: 0 },
    methodId: method.id,
  };
  await auth.usable(conn);
  assert.equal(requests.length, 1);
  await auth.usable(conn, { force: true });
  assert.deepEqual(requests, [false, false]);
  valid = false;
  await auth.usable(conn, { force: true });
  assert.deepEqual(requests, [false, false, false, true]);
  const old = createAuth(context(oauthFixture()), client).methods[0];
  assert.match(old.unavailable, /Upgrade Switchboard/);
});
test("web capabilities describe native checks without inventing OAuth scopes and enforce read-only", async () => {
  const service = new SlackService({ call: async () => response }, "/unused");
  const conn = { config: { access: "read" }, credentials: bundle() };
  const caps = await service.invoke(
    operations.find((o) => o.id === "getSlackCapabilities"),
    {},
    conn,
  );
  assert.equal(caps.authentication, "web-session");
  assert.deepEqual(caps.scopes, []);
  assert.equal(caps.features.search, true);
  assert.equal(caps.canWrite, false);
  await assert.rejects(
    service.invoke(
      operations.find((o) => o.id === "postSlackMessage"),
      {},
      conn,
    ),
    { code: "permission_denied" },
  );
});

test("browser capture closes its private browser, keeps profile private and exports only session pair", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "slack-browser-fixture-"),
  );
  let closed = false;
  class Browser {
    constructor() {
      this.listener = () => {};
    }
    subscribe(fn) {
      this.listener = fn;
      return () => {};
    }
    async call(method) {
      assert.equal(method, "Browser.getVersion");
      return { userAgent: "fixture-agent" };
    }
    async page() {
      return {
        call: async (method) => {
          if (method === "Page.navigate")
            this.listener({
              method: "Network.requestWillBeSent",
              params: {
                request: {
                  url: "https://fixture.slack.com/api/auth.test",
                  postData: JSON.stringify({ token }),
                },
              },
            });
          if (method === "Network.getCookies")
            return {
              cookies: [
                { name: "d", domain: ".slack.com", value: cookie },
                {
                  name: "irrelevant",
                  domain: ".slack.com",
                  value: "not-exported",
                },
              ],
            };
        },
      };
    }
    async close() {
      closed = true;
    }
  }
  try {
    const result = await captureBrowser(path.join(dir, "profile"), selected, {
      browserPath: process.execPath,
      Browser,
      verify: async (c) => {
        assert.equal(c.cookie, cookie);
        assert.equal(c.accessToken, token);
        assert.equal(c.userAgent, "fixture-agent");
        assert.equal(c.irrelevant, undefined);
        return { credentials: bundle(), account };
      },
    });
    assert.equal(result.account.id, account.id);
    assert.equal(closed, true);
    assert.equal(
      (await fs.stat(path.join(dir, "profile"))).mode & 0o777,
      0o700,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("read-only Snappy decoder handles literals and overlapping copies and rejects oversized/corrupt blocks", async () => {
  const { unsnappy } = await import(
    "../plugins/slack-authentication/lib/leveldb.js"
  );
  assert.equal(
    unsnappy(Buffer.from([6, 4, 97, 98, 1, 2])).toString(),
    "ababab",
  );
  assert.equal(unsnappy(Buffer.from([3, 8, 97, 98, 99])).toString(), "abc");
  for (const b of [
    [1, 1, 0],
    [128, 128, 128, 127],
    [3, 8, 97],
  ])
    assert.throws(() => unsnappy(Buffer.from(b)));
});

test("compressed LevelDB tables expose only decoded blocks and corrupt handles fail closed", async () => {
  const { tableBlocks } = await import(
    "../plugins/slack-authentication/lib/leveldb.js"
  );
  const data = Buffer.from(token),
    compressed = Buffer.concat([
      Buffer.from([data.length, (data.length - 1) << 2]),
      data,
    ]);
  const block = Buffer.concat([compressed, Buffer.from([1, 0, 0, 0, 0])]);
  const index = Buffer.concat([
    Buffer.from([0, 1, 2, 97, 0, compressed.length]),
    Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]),
  ]);
  const footer = Buffer.alloc(48);
  footer.set([0, 0, block.length, index.length]);
  Buffer.from("57fb808b247547db", "hex").copy(footer, 40);
  const file = Buffer.concat([block, index, Buffer.alloc(5), footer]);
  const decoded = tableBlocks(file);
  assert.equal(decoded.length, 1);
  assert.deepEqual(extractTokens(decoded[0]), [token]);
  const bad = Buffer.from(file);
  bad[bad.length - 46] = 127;
  assert.throws(() => tableBlocks(bad));
  assert.deepEqual(tableBlocks(Buffer.from("not a table")), []);
});
