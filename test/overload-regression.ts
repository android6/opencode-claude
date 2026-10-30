/**
 * Regression: a turn the CLI ends as "success" after its own API retries
 * ran out (api_error_status 529 or another 5xx, no content) is a retryable
 * 503, not an empty successful answer. The proxy adds no retries of its own.
 *
 * Run: bun test/overload-regression.ts
 */
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const { post, proxy } = await startMockedProxy("overload");
  let spawns = 0;
  const turn = (events: unknown[]) =>
    proxy.setClaudeQueryStarter(async () => {
      spawns += 1;
      return mockHandle(
        (async function* () {
          yield* events;
        })(),
      );
    });
  const emptySuccess = (status: number) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: status,
    result: "",
    stop_reason: null,
    usage: {},
  });
  try {
    for (const stream of [true, false]) {
      turn([{ type: "system", subtype: "init", session_id: "s" }, emptySuccess(529)]);
      spawns = 0;
      const res = await post(`overloaded-${stream}`, { stream, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 503);
      const body = (await res.json()) as any;
      assert.equal(body.error.type, "server_error");
      assert.equal(body.error.code, "overloaded_error");
      assert.match(body.error.message, /Anthropic is overloaded \(529\)/);
      assert.equal(spawns, 1, "no retries of our own");
    }

    turn([emptySuccess(502)]);
    {
      const res = await post("bad-gateway", { stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 503);
      assert.match(((await res.json()) as any).error.message, /Anthropic returned 502/);
    }

    // An answer that already streamed stays a success.
    for (const stream of [true, false]) {
      turn([textDelta("real answer"), emptySuccess(529)]);
      const res = await post(`answered-${stream}`, { stream, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /real answer/);
      assert.doesNotMatch(text, /overloaded/);
    }

    // A real success with no api_error_status is untouched.
    turn([textDelta("fine"), { ...emptySuccess(0), api_error_status: null }]);
    assert.equal((await post("fine", { stream: true, messages: [{ role: "user", content: "hi" }] })).status, 200);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — overload regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
