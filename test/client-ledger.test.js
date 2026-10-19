import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SlackClient } from "../plugins/slack/lib/client.js";
import { Ledger } from "../plugins/slack/lib/ledger.js";
import { fail } from "../plugins/slack/lib/errors.js";
import { credentials } from "./fixture.js";
test("Slack HTTP-200 errors are not mistaken for success and never echo provider secrets", async () => {
  for (const [error, status] of [
    ["invalid_auth", 401],
    ["token_revoked", 401],
    ["missing_scope", 403],
    ["channel_not_found", 400],
  ]) {
    const api = new SlackClient(async (url, opts) => {
      assert.equal(url, "https://slack.com/api/auth.test");
      assert.equal(opts.redirect, "error");
      assert.equal(opts.headers.authorization, "Bearer fixture-access");
      return Response.json({
        ok: false,
        error,
        error_description: "private-provider-secret",
      });
    });
    await assert.rejects(
      api.call(credentials(), "auth.test"),
      (e) =>
        e.code === error &&
        e.status === status &&
        !e.message.includes("private-provider-secret"),
    );
  }
});
test("rate limit cooldown is scoped to workspace and method and exposes Retry-After", async () => {
  let calls = 0;
  const api = new SlackClient(async () => {
    calls++;
    return new Response(null, {
      status: 429,
      headers: { "retry-after": "120" },
    });
  });
  await assert.rejects(
    api.call(credentials(), "conversations.history"),
    (e) => e.status === 429 && e.retryAfter === 120,
  );
  await assert.rejects(api.call(credentials(), "conversations.history"), {
    status: 429,
  });
  assert.equal(calls, 1);
  await assert.rejects(api.call(credentials(), "users.info"), { status: 429 });
  assert.equal(calls, 2);
  await assert.rejects(
    api.call(credentials({ teamId: "T99999999" }), "conversations.history"),
    { status: 429 },
  );
  assert.equal(calls, 3);
  await assert.rejects(api.call(credentials(), "admin.users.remove"), {
    code: "unsupported_method",
  });
  assert.equal(calls, 3);
});
test("oversized and non-JSON provider responses fail without exposing body content", async () => {
  for (const response of [
    new Response("private-secret"),
    new Response("x".repeat(4 * 1024 * 1024 + 1)),
  ]) {
    const client = new SlackClient(async () => response);
    await assert.rejects(
      client.call(credentials(), "auth.test"),
      (e) =>
        ["invalid_response", "response_too_large"].includes(e.code) &&
        !e.message.includes("private-secret"),
    );
  }
});
test("ledger prevents duplicates across instances and restarts, rejects changed content and uncertain retries", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-ledger-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let sent = 0;
  const ledger = new Ledger(dir, "workspace:user"),
    send = () => {
      sent++;
      return { ok: true, channel: "C12345678", ts: "1234567890.000001" };
    };
  await ledger.run("stable-key", { text: "hello" }, async () => {}, send);
  const replay = await new Ledger(dir, "workspace:user").run(
    "stable-key",
    { text: "hello" },
    async () => {},
    send,
  );
  assert.equal(replay.replayed, true);
  assert.equal(sent, 1);
  await assert.rejects(
    ledger.run("stable-key", { text: "changed" }, async () => {}, send),
    { code: "idempotency_conflict" },
  );
  await assert.rejects(
    ledger.run(
      "unknown-key",
      { text: "uncertain" },
      async () => {},
      async () => {
        sent++;
        throw Error("timeout");
      },
    ),
  );
  await assert.rejects(
    new Ledger(dir, "workspace:user").run(
      "unknown-key",
      { text: "uncertain" },
      async () => {},
      send,
    ),
    { code: "uncertain" },
  );
  assert.equal(sent, 2);
  const files = await fs.readdir(ledger.dir);
  const state = await fs.readFile(path.join(ledger.dir, files[0]), "utf8");
  assert(!state.includes("hello"));
  assert(!state.includes("uncertain"));
  assert.equal(
    (await fs.stat(path.join(ledger.dir, files[0]))).mode & 0o777,
    0o600,
  );
});
test("definitively rejected sends may retry the same key, simultaneous sends cannot duplicate", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-ledger-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledger = new Ledger(dir, "account");
  let count = 0;
  await assert.rejects(
    ledger.run(
      "retry-key",
      {},
      async () => {},
      async () => {
        throw fail("invalid_auth", 401, { definitive: true });
      },
    ),
  );
  const write = async () => {
    count++;
    return { ok: true };
  };
  await Promise.all([
    ledger.run("retry-key", {}, async () => {}, write),
    ledger.run("retry-key", {}, async () => {}, write),
  ]);
  assert.equal(count, 1);
});
