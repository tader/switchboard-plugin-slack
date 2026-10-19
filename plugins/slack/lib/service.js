import path from "node:path";
import { Ledger } from "./ledger.js";
import { fail, publicError } from "./errors.js";
import { WRITE_SCOPES } from "./auth.js";
export const compareTs = (a, b) => {
  const parse = (x) => {
    const [s, f] = x.split(".");
    return BigInt(s) * 1000000n + BigInt(f);
  };
  return parse(a) < parse(b) ? -1 : parse(a) > parse(b) ? 1 : 0;
};
export class SlackService {
  constructor(client, root) {
    this.client = client;
    this.root = root;
    this.ledgers = new Map();
  }
  async invoke(op, input, conn, signal) {
    if (op.write && conn.config.access !== "write")
      throw fail("permission_denied", 403);
    const c = conn.credentials,
      call = (method, args) => this.client.call(c, method, args, signal);
    const account = `${c.teamId}:${c.userId}`;
    const granted = new Set(
      String(c.scope ?? "")
        .split(/[ ,]+/)
        .filter(Boolean),
    );
    const web = c.kind === "web";
    const capabilities = {
      authentication: web ? "web-session" : "oauth",
      permissionCoverage: web
        ? "native_session_permissions_checked_by_slack"
        : "oauth_scopes",
      workspace: c.teamId,
      user: c.userId,
      access: conn.config.access,
      scopes: [...granted],
      canWrite:
        conn.config.access === "write" && (web || granted.has("chat:write")),
      canMarkRead:
        conn.config.access === "write" &&
        (web || WRITE_SCOPES.slice(2).some((s) => granted.has(s))),
      markUnread: false,
      nativeUnreadCoverage: "only_where_returned",
      automaticReadMarkers: false,
    };
    capabilities.features = {
      search: web || granted.has("search:read"),
      users: web || granted.has("users:read"),
      history: Object.fromEntries(
        ["channels", "groups", "im", "mpim"].map((kind) => [
          kind,
          web || granted.has(`${kind}:history`),
        ]),
      ),
      send: capabilities.canWrite,
      reactions:
        conn.config.access === "write" &&
        (web || granted.has("reactions:write")),
      markRead: Object.fromEntries(
        ["channels", "groups", "im", "mpim"].map((kind) => [
          kind,
          conn.config.access === "write" &&
            (web || granted.has(`${kind}:write`)),
        ]),
      ),
    };
    if (op.id === "getSlackCapabilities") return capabilities;
    if (op.id === "getSlackStatus") {
      const who = await call("auth.test", {});
      if (who.team_id !== c.teamId || who.user_id !== c.userId)
        throw fail("account_mismatch", 403);
      return {
        ready: true,
        workspace: c.teamId,
        user: c.userId,
        expiresAt: c.expiresAt ?? null,
      };
    }
    const page = (data, field) => ({
      items: data[field] ?? [],
      nextCursor: data.response_metadata?.next_cursor || null,
      hasMore: !!data.has_more,
    });
    if (op.id === "listSlackConversations") {
      const types = input.types ?? "public_channel,private_channel,im,mpim";
      if (
        types
          .split(",")
          .some(
            (t) =>
              !["public_channel", "private_channel", "im", "mpim"].includes(t),
          )
      )
        throw fail("invalid_input");
      return page(
        await call("users.conversations", {
          types,
          limit: input.limit,
          cursor: input.cursor,
          exclude_archived: true,
        }),
        "channels",
      );
    }
    if (op.id === "listSlackMessages")
      return page(await call("conversations.history", input), "messages");
    if (op.id === "getSlackThread")
      return page(
        await call("conversations.replies", {
          channel: input.channel,
          ts: input.threadTs,
          limit: input.limit,
          cursor: input.cursor,
        }),
        "messages",
      );
    if (op.id === "listSlackUsers")
      return page(await call("users.list", input), "members");
    if (op.id === "getSlackUser") return (await call("users.info", input)).user;
    if (op.id === "getSlackPermalink")
      return {
        url: (
          await call("chat.getPermalink", {
            channel: input.channel,
            message_ts: input.ts,
          })
        ).permalink,
      };
    if (op.id === "searchSlackMessages") {
      const data = await call("search.messages", {
          ...input,
          sort: "timestamp",
          sort_dir: "desc",
        }),
        m = data.messages ?? {};
      return {
        items: m.matches ?? [],
        page: m.paging?.page ?? input.page,
        nextPage:
          m.paging && m.paging.page < m.paging.pages ? m.paging.page + 1 : null,
        total: m.paging?.total ?? m.total ?? null,
      };
    }
    if (op.id === "getSlackTriageInbox") {
      const data = await call("users.conversations", {
          types: "public_channel,private_channel,im,mpim",
          exclude_archived: true,
          ...input,
        }),
        items = [];
      for (const channel of data.channels ?? []) {
        try {
          const info = (
            await call("conversations.info", { channel: channel.id })
          ).channel;
          const count = Number.isSafeInteger(info.unread_count)
            ? info.unread_count
            : null;
          const unread =
            count !== null
              ? count > 0
              : info.last_read && info.latest?.ts
                ? compareTs(info.latest.ts, info.last_read) > 0
                : null;
          items.push({
            channel: info.id ?? channel.id,
            name: info.name ?? channel.name ?? null,
            isDM: !!info.is_im,
            unread,
            unreadCount: count,
            lastRead: info.last_read ?? null,
            latest: info.latest ?? null,
          });
        } catch (e) {
          items.push({
            channel: channel.id,
            unread: null,
            unreadCount: null,
            error: publicError(e),
          });
        }
      }
      return {
        items,
        nextCursor: data.response_metadata?.next_cursor || null,
        coverage: "scanned_page_only",
        complete:
          !data.has_more &&
          !data.response_metadata?.next_cursor &&
          items.every((i) => !i.error),
        unknownUnread: items.filter((i) => i.unread === null).length,
      };
    }
    const exact = async (target) => {
      let cursor;
      for (let n = 0; n < (target.threadTs ? 5 : 1); n++) {
        const data = await call(
          target.threadTs ? "conversations.replies" : "conversations.history",
          target.threadTs
            ? {
                channel: target.channel,
                ts: target.threadTs,
                cursor,
                limit: 100,
              }
            : {
                channel: target.channel,
                oldest: target.ts,
                latest: target.ts,
                inclusive: true,
                limit: 1,
              },
        );
        const m = data.messages?.find((m) => m.ts === target.ts);
        if (m) return m;
        cursor = data.response_metadata?.next_cursor;
        if (!cursor) break;
      }
      throw fail("message_not_found", 404);
    };
    if (op.id === "getSlackReplyContexts")
      return {
        items: await Promise.all(
          input.items.map(async (target) => {
            try {
              return {
                target,
                message: await exact(target),
                ...(target.threadTs
                  ? {
                      thread:
                        (
                          await call("conversations.replies", {
                            channel: target.channel,
                            ts: target.threadTs,
                            limit: 20,
                          })
                        ).messages ?? [],
                    }
                  : {}),
              };
            } catch (e) {
              return { target, error: publicError(e) };
            }
          }),
        ),
      };
    if (op.id === "replySlackBatch") {
      const keys = input.items.map((i) => i.idempotencyKey);
      if (new Set(keys).size !== keys.length)
        throw fail("duplicate_idempotency_key");
      const items = [];
      for (const item of input.items) {
        try {
          items.push({
            idempotencyKey: item.idempotencyKey,
            result: await this.invoke(
              { ...op, id: "postSlackMessage" },
              item,
              conn,
              signal,
            ),
          });
        } catch (e) {
          items.push({
            idempotencyKey: item.idempotencyKey,
            error: publicError(e),
          });
        }
      }
      return { items };
    }
    let ledger = this.ledgers.get(account);
    if (!ledger) {
      ledger = new Ledger(path.join(this.root, "operations"), account);
      this.ledgers.set(account, ledger);
    }
    return ledger.run(
      input.idempotencyKey,
      { operation: op.id, input },
      async () => {
        if (op.id === "postSlackMessage" && input.threadTs) {
          const root = (
            await call("conversations.replies", {
              channel: input.channel,
              ts: input.threadTs,
              limit: 1,
            })
          ).messages?.[0];
          if (
            root?.ts !== input.threadTs ||
            (root.thread_ts && root.thread_ts !== root.ts)
          )
            throw fail("invalid_thread_target");
        }
        if (
          ["editSlackMessage", "deleteSlackMessage", "markSlackRead"].includes(
            op.id,
          )
        ) {
          const m = await exact(input);
          if (op.id !== "markSlackRead" && (m.user !== c.userId || m.bot_id))
            throw fail("not_your_message", 403);
          if (input.expectedText !== undefined && m.text !== input.expectedText)
            throw fail("stale_message", 409);
          if (
            op.id === "markSlackRead" &&
            input.threadTs &&
            input.threadTs !== input.ts
          )
            throw fail("thread_read_marker_unsupported", 400);
          if (op.id === "markSlackRead") {
            const info = (
              await call("conversations.info", { channel: input.channel })
            ).channel;
            if (info.last_read && compareTs(info.last_read, input.ts) > 0)
              throw fail("read_marker_already_advanced", 409);
          }
        }
      },
      async () => {
        let data;
        switch (op.id) {
          case "postSlackMessage":
            data = await call("chat.postMessage", {
              channel: input.channel,
              text: input.text,
              thread_ts: input.threadTs,
              mrkdwn: true,
              unfurl_links: false,
              unfurl_media: false,
            });
            break;
          case "editSlackMessage":
            data = await call("chat.update", {
              channel: input.channel,
              ts: input.ts,
              text: input.text,
            });
            break;
          case "deleteSlackMessage":
            data = await call("chat.delete", {
              channel: input.channel,
              ts: input.ts,
            });
            break;
          case "addSlackReaction":
            data = await call("reactions.add", {
              channel: input.channel,
              timestamp: input.ts,
              name: input.name,
            });
            break;
          case "removeSlackReaction":
            data = await call("reactions.remove", {
              channel: input.channel,
              timestamp: input.ts,
              name: input.name,
            });
            break;
          case "markSlackRead":
            data = await call("conversations.mark", {
              channel: input.channel,
              ts: input.ts,
            });
            break;
          case "openSlackConversation":
            data = await call("conversations.open", {
              users: input.users.join(","),
            });
            break;
          default:
            throw fail("unsupported_operation");
        }
        if (
          [
            "postSlackMessage",
            "editSlackMessage",
            "deleteSlackMessage",
          ].includes(op.id) &&
          (data.channel !== input.channel ||
            typeof data.ts !== "string" ||
            !/^\d{1,16}\.\d{6}$/.test(data.ts) ||
            (op.id !== "postSlackMessage" && data.ts !== input.ts))
        )
          throw fail("invalid_write_receipt", 502);
        if (
          op.id === "openSlackConversation" &&
          (typeof data.channel?.id !== "string" ||
            !/^D[A-Z0-9]{7,}$|^G[A-Z0-9]{7,}$/.test(data.channel.id))
        )
          throw fail("invalid_write_receipt", 502);
        return {
          ok: true,
          ...(data.channel
            ? {
                channel:
                  typeof data.channel === "string"
                    ? data.channel
                    : data.channel.id,
              }
            : {}),
          ...(data.ts ? { ts: data.ts } : {}),
        };
      },
    );
  }
}
