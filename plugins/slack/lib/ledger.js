import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  return JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
export class Ledger {
  constructor(root, account) {
    this.dir = path.join(root, hash(account));
    this.queue = Promise.resolve();
  }
  run(key, payload, prepare, write) {
    const task = this.queue.then(() =>
      this.execute(key, payload, prepare, write),
    );
    this.queue = task.catch(() => {});
    return task;
  }
  async execute(key, payload, prepare, write) {
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      throw fail("invalid_idempotency_key");
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dir, ".lock");
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch {
      throw fail("ledger_locked", 503);
    }
    try {
      const file = path.join(this.dir, hash(key) + ".json"),
        fingerprint = hash(canonical(payload));
      let record;
      try {
        record = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw fail("ledger_invalid", 503);
      }
      if (record) {
        if (record.fingerprint !== fingerprint)
          throw fail("idempotency_conflict", 409);
        if (record.state === "accepted")
          return { ...record.result, replayed: true };
        if (record.state !== "rejected") throw fail("uncertain", 409);
      }
      if (
        !record &&
        (await fs.readdir(this.dir)).filter((f) => f.endsWith(".json"))
          .length >= 10000
      )
        throw fail("ledger_full", 503);
      await prepare();
      const save = async (value) => {
        const temp = file + "." + randomUUID(),
          handle = await fs.open(temp, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(value));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, file);
        const directory = await fs.open(this.dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      };
      record = {
        fingerprint,
        state: "attempted",
        at: new Date().toISOString(),
      };
      await save(record);
      let result;
      try {
        result = await write();
      } catch (e) {
        if (e.definitive) await save({ ...record, state: "rejected" });
        throw e;
      }
      // If receipt persistence fails, the durable attempted record still prevents resending.
      await save({ ...record, state: "accepted", result });
      return result;
    } finally {
      await fs.rmdir(lock);
    }
  }
}
