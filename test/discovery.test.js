import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../plugins/slack/lib/adapter.js";
import { SlackClient } from "../plugins/slack/lib/client.js";
import { credentials, context, oauthFixture } from "./fixture.js";

for (const mode of ["web-session", "oauth"]) {
  test(`${mode}: HTTP discovery forwards filters/cursors, bounds roster pages and encodes search`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-discovery-"));
    const calls = [];
    const c = credentials(
      mode === "web-session"
        ? {
            kind: "web",
            accessToken: "xoxc-fixture-session-token",
            cookie: "xoxd-fixture-session-cookie",
            userAgent: "fixture-agent",
            validatedAt: Date.now(),
          }
        : {},
    );
    const client = new SlackClient(async (url, opts) => {
      const method = new URL(url).pathname.split("/").at(-1);
      assert.equal(opts.method, "POST");
      assert.equal(
        opts.headers["content-type"],
        "application/x-www-form-urlencoded",
      );
      assert.equal(opts.headers.authorization, `Bearer ${c.accessToken}`);
      assert.equal(
        opts.headers.cookie,
        mode === "web-session" ? `d=${c.cookie}` : undefined,
      );
      assert.equal(
        new URL(url).search,
        "",
        "credentials and filters stay out of the URL",
      );
      const args = Object.fromEntries(new URLSearchParams(opts.body));
      assert.equal(args.token, undefined);
      calls.push({ method, args });
      if (method === "users.conversations") {
        assert.equal(args.exclude_archived, "true");
        assert.equal(args.limit, "100");
        if (!args.cursor)
          return Response.json({
            ok: true,
            channels: [],
            response_metadata: { next_cursor: "channel-page=2+" },
          });
        assert.equal(args.cursor, "channel-page=2+");
        return Response.json({
          ok: true,
          channels: [
            {
              id: "C06CA7QH1H9",
              name: "xebia-cloudnl",
              is_private: true,
              is_im: false,
            },
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      if (method === "users.list") {
        assert(["1", "200"].includes(args.limit));
        if (!args.cursor)
          return Response.json({
            ok: true,
            members: [{ id: "UFIRST123" }],
            response_metadata: { next_cursor: "user-page=2+" },
          });
        assert.equal(args.cursor, "user-page=2+");
        return Response.json({
          ok: true,
          members: [{ id: "URENALD12", real_name: "Renald Butter" }],
          response_metadata: { next_cursor: "" },
        });
      }
      if (method === "search.messages") {
        assert.equal(args.sort, "timestamp");
        assert.equal(args.sort_dir, "desc");
        assert.equal(args.query, 'in:xebia-cloudnl "a+b & c"');
        return Response.json({
          ok: true,
          messages: {
            matches: [{ ts: "1792400000.000001" }],
            paging: { page: Number(args.page), pages: 2, total: 4 },
          },
        });
      }
      throw new Error("Unexpected fixture operation");
    });
    const instance = await createAdapter(
      { ...context(oauthFixture()), dataDir: dir },
      { client },
    );
    t.after(async () => {
      await instance.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const auth = instance.services[0].authMethods.find(
      (m) =>
        m.id === (mode === "web-session" ? "authentication-source" : "oauth"),
    );
    const conn = {
      methodId: auth.id,
      credentials: c,
      config: { access: "read", authenticationSource: "fixture-source" },
    };
    async function get(pathname) {
      const req = {
        method: "GET",
        url: new URL(pathname, "http://slack.localhost"),
        headers: new Headers(),
      };
      await auth.authorize(req, conn);
      const res = await fetch(req.url, { headers: req.headers });
      assert.equal(res.status, 200);
      return res.json();
    }
    for (const types of [
      "private_channel",
      "public_channel,private_channel",
      "private_channel,im",
    ]) {
      const first = await get(
        "/conversations?limit=100&types=" + encodeURIComponent(types),
      );
      assert.deepEqual(first.items, []);
      assert.equal(first.nextCursor, "channel-page=2+");
      assert.equal(
        first.hasMore,
        true,
        "empty native pages may still have a cursor",
      );
      const next = await get(
        "/conversations?limit=100&types=" +
          encodeURIComponent(types) +
          "&cursor=" +
          encodeURIComponent(first.nextCursor),
      );
      assert.equal(next.items[0].id, "C06CA7QH1H9");
      assert.equal(next.items[0].is_private, true);
      assert.equal(next.nextCursor, null);
      assert.equal(next.hasMore, false);
      assert.equal(calls.at(-1).args.types, types);
    }
    const one = await get("/users?limit=1");
    assert.equal(one.items.length, 1);
    assert.equal(one.hasMore, true);
    const next = await get(
      "/users?limit=1&cursor=" + encodeURIComponent(one.nextCursor),
    );
    assert.equal(next.items[0].real_name, "Renald Butter");
    assert.equal(next.nextCursor, null);
    await get("/users?limit=200");
    const query = encodeURIComponent('in:xebia-cloudnl "a+b & c"');
    const search = await get("/search?query=" + query + "&page=1&count=3");
    assert.equal(search.items.length, 1);
    assert.equal(search.nextPage, 2);
    assert.equal(calls.at(-1).args.count, "3");
    await get("/search?query=" + query);
    assert.equal(calls.at(-1).args.count, "50");
    assert.equal(calls.at(-1).args.page, "1");
    assert(
      calls.every((c) =>
        ["users.conversations", "users.list", "search.messages"].includes(
          c.method,
        ),
      ),
      "reads never mutate Slack",
    );
  });
}

test("read parameters omit absent values while mutation request bodies remain JSON", async () => {
  const calls = [];
  const client = new SlackClient(async (url, opts) => {
    calls.push({ url, opts });
    return Response.json({ ok: true });
  });
  const c = credentials();
  await client.call(c, "conversations.history", {
    channel: "C12345678",
    limit: 1,
    cursor: undefined,
    oldest: null,
    inclusive: false,
  });
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(calls[0].opts.body)),
    { channel: "C12345678", limit: "1", inclusive: "false" },
  );
  for (const method of [
    "chat.postMessage",
    "chat.update",
    "chat.delete",
    "reactions.add",
    "reactions.remove",
    "conversations.mark",
    "conversations.open",
  ]) {
    const args = { channel: "C12345678", text: "a+b & c", unfurl_links: false };
    await client.call(c, method, args);
    assert.equal(calls.at(-1).opts.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls.at(-1).opts.body), args);
  }
});
