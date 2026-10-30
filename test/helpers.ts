/**
 * Shared setup for the *-regression.ts files: isolated plugin data, a
 * signed-in plan, and a proxy driven by a mocked Agent SDK turn.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startMockedProxy(label: string) {
  // Env must be set before the proxy modules load.
  const tmp = mkdtempSync(join(tmpdir(), `opencode-claude-${label}-`));
  process.env.XDG_DATA_HOME = tmp;
  // Mocked turns ignore interrupt(); don't wait the real grace for them.
  process.env.OPENCODE_CLAUDE_STOP_GRACE_MS ??= "50";
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  const { setAuthStatusProbe } = await import("../src/detect.ts");
  setAuthStatusProbe(() => ({ loggedIn: true, detail: "auth-status-oauth" }));
  const proxy = await import("../src/proxy.ts");
  const port = await proxy.startProxy();
  const post = (
    session: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": session,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, ...body }),
    });
  return { tmp, port, post, proxy };
}

/** The in-process MCP server's request handlers, as the SDK would call them. */
export function mcpHandlers(params: { mcpServers?: unknown }) {
  const server = (params.mcpServers as Record<string, any>).opencode;
  return server.instance.server._requestHandlers as Map<
    string,
    (req: unknown, extra: unknown) => Promise<any>
  >;
}

export const mcpExtra = {
  signal: new AbortController().signal,
  sendNotification: async () => {},
  sendRequest: async () => {},
};

export function callTool(
  params: { mcpServers?: unknown },
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<Record<string, any>> }> {
  return mcpHandlers(params).get("tools/call")!(
    { method: "tools/call", params: { name, arguments: args } },
    mcpExtra,
  );
}

export function mockHandle(stream: AsyncIterable<unknown>, onClose?: () => void) {
  return {
    stream,
    interrupt: async () => {},
    close: () => onClose?.(),
    getPid: () => null,
  };
}

export const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

export const bashTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mock SDK turn: runs `body`, and on interrupt() yields what the CLI emits
 * for an interrupted tool call (the rejection, the marker, an aborted_tools
 * result) and ends, like the real CLI does.
 */
export function interruptibleTurn(
  log: string[],
  name: string,
  body: () => AsyncGenerator<unknown>,
  options: { settleMs?: number; sessionId?: string } = {},
) {
  const { settleMs = 0, sessionId } = options;
  const session = sessionId ? { session_id: sessionId } : {};
  let interrupted!: () => void;
  const interruptSignal = new Promise<"interrupt">((r) => (interrupted = () => r("interrupt")));
  const stream = (async function* () {
    const inner = body();
    while (true) {
      const next = await Promise.race([inner.next(), interruptSignal]);
      if (next === "interrupt") break;
      if (next.done) return;
      yield next.value;
    }
    if (settleMs > 0) await sleep(settleMs);
    yield { type: "user", uuid: `${name}-reject`, parent_tool_use_id: null, message: { content: [] }, ...session };
    yield { type: "user", uuid: `${name}-marker`, parent_tool_use_id: null, message: { content: [] }, ...session };
    yield {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      terminal_reason: "aborted_tools",
      ...session,
    };
  })();
  return {
    stream,
    interrupt: async () => {
      log.push(`${name}:interrupt`);
      interrupted();
    },
    close: () => log.push(`${name}:close`),
    getPid: () => null,
  };
}

export { assert };
