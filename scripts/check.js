import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { scopesFor } from "../plugins/slack/lib/auth.js";
import { operations, openapi } from "../plugins/slack/lib/operations.js";
const manifest = JSON.parse(
  fs.readFileSync("plugins/slack/plugin.json", "utf8"),
);
assert.deepEqual(
  JSON.parse(fs.readFileSync("plugins/slack/app-manifest.json", "utf8"))
    .oauth_config.scopes.user,
  scopesFor("write"),
);
assert.equal(manifest.id, "slack");
assert.equal(
  manifest.version,
  JSON.parse(fs.readFileSync("package.json", "utf8")).version,
);
assert.equal(new Set(operations.map((op) => op.id)).size, operations.length);
for (const op of operations)
  assert.equal(
    openapi.paths[op.path][op.method.toLowerCase()].operationId,
    op.id,
  );
for (const root of ["plugins/slack/lib", "scripts", "test"])
  for (const f of fs.readdirSync(root))
    if (f.endsWith(".js"))
      execFileSync(process.execPath, ["--check", `${root}/${f}`]);
console.log(
  `Validated ${operations.length} Slack operations and plugin manifest`,
);
