import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pbkdf2Sync, createDecipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { candidate, identify, fail } from "./session.js";
import { tableBlocks } from "./leveldb.js";
const run = promisify(execFile);
export function decryptCookie(encrypted, password, host, version) {
  const b = Buffer.from(encrypted);
  if (b.subarray(0, 3).toString() !== "v10")
    throw fail("unsupported_cookie_encryption", 503);
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  try {
    const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    let plain = Buffer.concat([d.update(b.subarray(3)), d.final()]);
    if (version >= 24) {
      if (
        !plain
          .subarray(0, 32)
          .equals(createHash("sha256").update(host).digest())
      )
        throw fail("invalid_cookie");
      plain = plain.subarray(32);
    }
    return plain.toString("utf8");
  } finally {
    key.fill(0);
  }
}
export function extractTokens(bytes) {
  return [
    ...new Set(
      bytes.toString("latin1").match(/xoxc-[A-Za-z0-9-]{10,2048}/g) ?? [],
    ),
  ];
}
export async function importDesktop(
  selected,
  {
    signal,
    platform = process.platform,
    home = os.homedir(),
    execute = run,
    verify = identify,
  } = {},
) {
  if (platform !== "darwin") throw fail("desktop_import_macos_only", 503);
  const roots = [
    path.join(home, "Library/Application Support/Slack"),
    path.join(
      home,
      "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack",
    ),
  ];
  let found = false;
  for (const root of roots) {
    const files = await fs
      .readdir(path.join(root, "Local Storage/leveldb"))
      .catch(() => []);
    if (!files.length) continue;
    found = true;
    let cookie, version, host, encrypted;
    for (const file of ["Cookies", "Network/Cookies"]) {
      let db;
      try {
        db = new DatabaseSync(path.join(root, file), { readOnly: true });
        const row = db
          .prepare(
            "SELECT host_key, value, encrypted_value FROM cookies WHERE name = 'd' AND host_key IN ('.slack.com','slack.com','app.slack.com') ORDER BY expires_utc DESC LIMIT 1",
          )
          .get();
        if (!row) continue;
        version = Number(
          db.prepare("SELECT value FROM meta WHERE key='version'").get()
            ?.value ?? 0,
        );
        host = row.host_key;
        cookie = row.value;
        encrypted = row.encrypted_value;
        break;
      } catch {
      } finally {
        db?.close();
      }
    }
    if (!cookie && encrypted?.length) {
      let password;
      try {
        // Only Slack's application key is requested; macOS retains control of Keychain approval.
        const result = await execute(
          "/usr/bin/security",
          ["find-generic-password", "-s", "Slack Safe Storage", "-w"],
          { signal, timeout: 30000, maxBuffer: 16384 },
        );
        password = result.stdout.replace(/\r?\n$/, "");
        cookie = decryptCookie(encrypted, password, host, version);
      } catch {
        throw fail("slack_keychain_access_required", 401);
      } finally {
        password = undefined;
      }
    }
    if (!cookie) continue;
    const tokens = new Set();
    let total = 0;
    for (const file of files.sort().reverse()) {
      if (!/\.(ldb|log)$/.test(file)) continue;
      const full = path.join(root, "Local Storage/leveldb", file),
        stat = await fs.stat(full);
      total += stat.size;
      if (stat.size > 32 * 1024 * 1024 || total > 128 * 1024 * 1024) continue;
      const bytes = await fs.readFile(full);
      try {
        for (const token of extractTokens(bytes)) tokens.add(token);
        if (file.endsWith(".ldb")) {
          let blocks = [];
          try {
            blocks = tableBlocks(bytes);
            for (const b of blocks)
              for (const token of extractTokens(b)) tokens.add(token);
          } catch {
          } finally {
            for (const b of blocks) b.fill(0);
          }
        }
      } finally {
        bytes.fill(0);
      }
      if (tokens.size > 32) break;
    }
    for (const token of [...tokens].slice(0, 32)) {
      signal?.throwIfAborted();
      try {
        return await verify(candidate(token, cookie), { selected, signal });
      } catch (error) {
        if (!["invalid_auth", "workspace_mismatch"].includes(error.code))
          throw error;
      }
    }
  }
  throw fail(
    found
      ? "desktop_session_unavailable_open_workspace_or_use_browser"
      : "slack_desktop_not_found",
    401,
  );
}
