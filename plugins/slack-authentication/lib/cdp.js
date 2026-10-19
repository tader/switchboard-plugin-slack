import { spawn } from "node:child_process";
import fs from "node:fs/promises";
class AdapterError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function findBrowser(configured) {
  const candidates = configured
    ? [configured]
    : [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
  for (const file of candidates) {
    if (
      await fs.access(file, fs.constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return file;
  }
  throw new AdapterError(
    "browser_missing",
    "Install Chrome or Edge, or set browserPath to its executable.",
    503,
  );
}

// Chrome's private pipe avoids an unauthenticated remote-debugging TCP listener.
export class CDP {
  constructor(
    executable,
    profile,
    { headless = false, extraArgs = [], spawnProcess = spawn } = {},
  ) {
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.child = spawnProcess(
      executable,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        ...(headless ? ["--headless=new"] : []),
        ...extraArgs,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    this.exit = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.on("error", () =>
      this.fail("Could not launch browser executable."),
    );
    this.child.on("exit", () =>
      this.fail("Browser closed. Reopen it with the login operation."),
    );
    this.child.stdio[3].on("error", () =>
      this.fail("Browser control pipe closed."),
    );
    this.child.stdio[4].on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end;
      while ((end = this.buffer.indexOf(0)) !== -1) {
        const raw = this.buffer.subarray(0, end).toString();
        this.buffer = this.buffer.subarray(end + 1);
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        if (message.method) {
          for (const listener of this.listeners) listener(message);
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error)
          waiter.reject(
            new AdapterError("browser_error", message.error.message, 502),
          );
        else waiter.resolve(message.result);
      }
      if (this.buffer.length > 8 * 1024 * 1024)
        this.fail("Browser response exceeded the limit.");
    });
  }

  fail(message) {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new AdapterError("browser_closed", message, 503));
    }
    this.pending.clear();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  call(method, params = {}, sessionId, timeout = 20_000) {
    if (this.closed)
      return Promise.reject(
        new AdapterError("browser_closed", "Browser is closed.", 503),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AdapterError("browser_timeout", `${method} timed out.`, 504),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + "\0",
      );
    });
  }

  async page(url) {
    await this.call("Browser.getVersion");
    const { targetId } = await this.call("Target.createTarget", { url });
    const { sessionId } = await this.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return new Page(this, sessionId, targetId);
  }

  async close() {
    if (!this.closed)
      await this.call("Browser.close", {}, undefined, 2000).catch(() => {});
    if (this.child.exitCode === null) {
      const timer = setTimeout(() => this.child.kill("SIGTERM"), 2000);
      let deadline;
      await Promise.race([
        this.exit,
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 3000);
        }),
      ]);
      clearTimeout(timer);
      clearTimeout(deadline);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    this.fail("Browser disposed.");
  }
}

export class Page {
  constructor(cdp, sessionId, targetId) {
    Object.assign(this, { cdp, sessionId, targetId });
  }
  call(method, params, timeout) {
    return this.cdp.call(method, params, this.sessionId, timeout);
  }
}
