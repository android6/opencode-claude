/**
 * Regression: chat turns with OpenCode tools ran Claude Code with
 * bypassPermissions, which the CLI refuses to start with as root, so the
 * plugin did not work on a root-only VPS. The turn now uses dontAsk with
 * the bridged OpenCode tools allowed; anything else is refused.
 *
 * Run: bun test/root-permissions-regression.ts
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const { post, proxy } = await startMockedProxy("root-permissions");
  let seen: StartClaudeQueryParams | null = null;
  proxy.setClaudeQueryStarter(async (params) => {
    seen = params;
    return mockHandle(
      (async function* () {
        yield textDelta("hi");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    );
  });
  const res = await post("root", { tools: [bashTool], messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  await res.text();
  const params = seen as StartClaudeQueryParams | null;
  assert.equal(params?.permissionMode, "dontAsk");
  assert.notEqual(params?.allowDangerouslySkipPermissions, true);
  assert.ok(params?.allowedTools?.some((name) => name.endsWith("bash")), "the bridged tools are allowed");
  assert.deepEqual(params?.tools, [], "no built-in tools");
  console.log("root-permissions regression ok");
  await proxy.stopProxy?.();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
