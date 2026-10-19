import type { PluginContext } from "./types/api.d.ts";
import { setupProvider } from "./lib/provider.js";
export default function setup(ctx: PluginContext) {
  return setupProvider(ctx);
}
