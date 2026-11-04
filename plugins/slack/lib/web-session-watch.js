import { randomUUID, createHash } from "node:crypto";
import { fail } from "./errors.js";
import { MESSAGE_EVENTS } from "./socket-mode.js";

/** Desktop/web RTM uses the existing user's session; no Slack app installation.
 * Each watch belongs to one exact connection and ends with its subscriber lease.
 * URLs/cookies and message bodies never enter event batches or error messages.
 */
export class WebSessionWatch {
  constructor(client, { createSocket = (url, headers) => new WebSocket(url, { headers }), helloTimeoutMs = 20000, heartbeatMs = 20000, now = Date.now } = {}) {
    this.client = client;
    this.createSocket = createSocket;
    this.helloTimeoutMs = helloTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.now = now;
    this.controllers = new Set();
    this.closed = false;
  }
  async watch(_input, ctx) {
    const c = ctx.connection.credentials;
    if (this.closed || c?.kind !== "web") throw fail("watch_not_supported", 501);
    ctx.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    this.controllers.add(controller);
    let socket, timer, heartbeat, ended = false, hello = false, queued = 0, tail = Promise.resolve(), sequence = 0;
    let resolve, reject;
    const done = new Promise((a, b) => { resolve = a; reject = b; });
    // A rejection can precede entering the receive await while an initial publish is pending.
    done.catch(() => {});
    const finish = (error) => { if (ended) return; ended = true; clearTimeout(timer); clearInterval(heartbeat); error ? reject(error) : resolve(); };
    const abort = () => finish();
    const publish = (type, sourceId) => {
      if (++queued > 128) { finish(fail("native_receive_overflow", 503)); return; }
      tail = tail.then(async () => {
        if (ended || signal.aborted) return;
        await ctx.publish({ checkpoint: sourceId, events: [{ sourceId, event: { category: "messaging", type, resourceType: "scope" } }] });
      }).catch(() => finish(fail("native_publish_failed", 503))).finally(() => { queued--; });
    };
    let lastFrame = this.now();
    const message = (event) => {
      if (ended || signal.aborted) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 1024 * 1024) throw fail("native_payload_invalid", 503);
        const frame = JSON.parse(event.data);
        if (!frame || typeof frame.type !== "string") throw fail("native_payload_invalid", 503);
        lastFrame = this.now();
        if (frame.type === "hello") {
          if (hello) throw fail("native_payload_invalid", 503);
          hello = true; clearTimeout(timer);
          publish("resync.required", "slack-web-connect:" + randomUUID());
        } else if (!hello) throw fail("native_payload_invalid", 503);
        else if (["goodbye", "reconnect_url"].includes(frame.type)) {
          // Do not follow a server-supplied replacement URL: renew the authenticated handshake.
          finish(fail("native_socket_closed", 503));
        } else if (["team_access_revoked", "account_inactive", "tokens_revoked"].includes(frame.type)) finish(fail("invalid_auth", 401));
        else if (frame.type === "error") finish(fail("native_source_unavailable", 503));
        else if (MESSAGE_EVENTS.has(frame.type)) {
          if (frame.team && frame.team !== c.teamId) throw fail("native_account_mismatch", 401);
          const identity = typeof frame.event_ts === "string" ? [c.teamId, frame.type, frame.channel, frame.event_ts] : [randomUUID()];
          const sourceId = "slack-web-event:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
          publish("invalidated", sourceId);
        }
      } catch (error) { finish(error?.code ? error : fail("native_payload_invalid", 503)); }
    };
    const close = () => finish(signal.aborted ? undefined : fail("native_socket_closed", 503));
    const error = () => finish(fail("native_source_unavailable", 503));
    signal.addEventListener("abort", abort, { once: true });
    try {
      // This call uses the exact same bounded, redirect-free session transport as reads.
      const data = await this.client.call(c, "rtm.connect", { token: c.accessToken, team_id: c.teamId, flannel_api_ver: "4" }, signal);
      if (data.team?.id !== c.teamId || data.self?.id !== c.userId) throw fail("native_account_mismatch", 401);
      let url;
      try { url = new URL(data.url); } catch { throw fail("native_endpoint_invalid", 503); }
      if (url.protocol !== "wss:" || !/^wss-(primary|backup)(-[a-z0-9-]+)?\.slack\.com$/.test(url.hostname) || url.port || url.username || url.password || url.hash) throw fail("native_endpoint_invalid", 503);
      signal.throwIfAborted();
      socket = this.createSocket(url.href, { cookie: "d=" + c.cookie, "user-agent": c.userAgent, origin: "https://app.slack.com" });
      socket.addEventListener("message", message); socket.addEventListener("close", close); socket.addEventListener("error", error);
      timer = setTimeout(() => finish(fail("native_hello_timeout", 503)), this.helloTimeoutMs); timer.unref?.();
      heartbeat = setInterval(() => {
        if (!hello || ended) return;
        if (this.now() - lastFrame > this.heartbeatMs * 3) return finish(fail("native_heartbeat_timeout", 503));
        try { socket.send(JSON.stringify({ id: ++sequence, type: "ping" })); } catch { finish(fail("native_source_unavailable", 503)); }
      }, this.heartbeatMs); heartbeat.unref?.();
      if (signal.aborted) abort();
      await done;
    } finally {
      ended = true; clearTimeout(timer); clearInterval(heartbeat); signal.removeEventListener("abort", abort);
      socket?.removeEventListener("message", message); socket?.removeEventListener("close", close); socket?.removeEventListener("error", error);
      try { socket?.close(); } catch {}
      await tail;
      this.controllers.delete(controller);
    }
  }
  async dispose() { this.closed = true; for (const c of this.controllers) c.abort(); }
}
