/**
 * Regression: OpenCode compacting a chat whose Claude turn is parked on a
 * tool call stops that turn, and the CLI records the pending call as
 * rejected by the user and the request as interrupted by the user. The
 * summary resumes the session after those entries, so it told the model
 * the user had rejected its calls. The summary prompt now says the stop
 * came from the plugin and relays the results OpenCode already has.
 *
 * Run: bun test/compaction-stopped-turn-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, callTool, interruptibleTurn, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SUMMARY_PROMPT = "Create a detailed summary for continuing this coding session.";

async function promptText(prompt: StartClaudeQueryParams["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  let text = "";
  for await (const part of prompt) {
    const content = (part as { message?: { content?: unknown } }).message?.content;
    text += typeof content === "string" ? content : JSON.stringify(content);
  }
  return text;
}

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-stopped-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  const chain = ["A1", "turn-reject", "turn-marker"];
  writeFileSync(
    join(projectDir, "stopped-sess.jsonl"),
    chain
      .map((uuid, i) =>
        JSON.stringify({ type: i === 0 ? "assistant" : "user", uuid, parentUuid: i > 0 ? chain[i - 1] : null }),
      )
      .join("\n") + "\n",
  );

  const { post, proxy } = await startMockedProxy("compaction-stopped");
  const log: string[] = [];
  let summary: StartClaudeQueryParams | null = null;
  proxy.setClaudeQueryStarter(async (params) => {
    if (params.persistSession === false) {
      summary = params;
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "fork-sess" };
          yield textDelta("## Objective\n- the summary");
          yield { type: "result", is_error: false, usage: {}, session_id: "fork-sess" };
        })(),
      );
    }
    return interruptibleTurn(
      log,
      "turn",
      async function* () {
        yield { type: "system", subtype: "init", session_id: "stopped-sess" };
        yield { type: "assistant", uuid: "A1", session_id: "stopped-sess", parent_tool_use_id: null, message: { content: [] } };
        await callTool(params, "bash", { command: "rg needle" });
      },
      { sessionId: "stopped-sess" },
    );
  });

  const messages = [{ role: "user", content: "find the needle" }];
  const first = (await (await post("chat", { tools: [bashTool], messages })).json()) as any;
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  const call = first.choices[0].message.tool_calls[0];

  // OpenCode ran the call, then compacted before sending its result.
  const res = await post("chat", {
    tools: [bashTool],
    messages: [
      ...messages,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "src/needle.ts:1" },
      { role: "user", content: SUMMARY_PROMPT },
    ],
  });
  assert.equal(res.status, 200);
  assert.match(((await res.json()) as any).choices[0].message.content, /the summary/);
  assert.ok(log.includes("turn:interrupt"), "the parked turn was stopped");
  const params = summary as StartClaudeQueryParams | null;
  assert.ok(params, "summary ran");
  assert.equal(params!.resume, "stopped-sess");
  const text = await promptText(params!.prompt);
  assert.ok(text.includes("<host_note>"), "the stop is attributed to the plugin");
  assert.ok(text.includes("nobody rejected anything"));
  assert.ok(text.includes("src/needle.ts:1"), "the result OpenCode has is relayed");
  assert.ok(text.includes(SUMMARY_PROMPT));

  console.log("compaction-stopped-turn regression ok");
  await proxy.stopProxy?.();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
