const label = value => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 512) || null : null;
export { label };

// Display metadata never replaces the opaque user ID used for routing.
export class DisplayNames {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.cache = new Map();
    this.pending = new Map();
    this.active = 0;
    this.waiters = [];
  }
  async resolve(ctx, id, lookup) {
    if (typeof id !== "string" || !/^[UW][A-Z0-9]{7,}$/.test(id)) return null;
    const c = ctx.connection;
    const key = JSON.stringify([c.id, c.credentials.teamId, c.credentials.userId, id]);
    const cached = this.cache.get(key);
    if (cached?.expires > this.now()) return cached.name;
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      if (this.active >= 4) await new Promise(resolve => this.waiters.push(resolve));
      else this.active++;
      try {
        ctx.signal?.throwIfAborted();
        let name = null;
        try {
          const user = await lookup(id);
          if (user?.id === id) name = label(user.profile?.display_name) || label(user.profile?.real_name) || label(user.real_name) || label(user.name);
        } catch (error) {
          if (!["not_found", "permission_denied"].includes(error.code)) throw error;
        }
        if (this.cache.size >= 4096) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { name, expires: this.now() + (name ? 3600000 : 300000) });
        return name;
      } finally {
        const next = this.waiters.shift();
        if (next) next(); else this.active--;
      }
    })();
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }
}
