/**
 * Thin wrapper around @anthropic-ai/claude-agent-sdk query()/interrupt.
 * Import failure is surfaced as unavailable — detect must not report ready.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { isClaudeEffort, type ClaudeEffort } from "./constants.js";
import {
  assertClaudeWorkingDirectory,
  isJsEntrypoint,
  resolveClaudeCodeExecutable,
} from "./executable-path.js";
import { log } from "./log.js";
import {
  cacheForListedModels,
  extendedProbeIds,
  listedModelIds,
  readContextWindowCache,
  writeContextWindowCache,
  type SdkModelRow,
} from "./models.js";

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let sdkModulePromise: Promise<SdkModule> | null = null;
let sdkLoadError: Error | null = null;
let sdkModule: SdkModule | null = null;

const ALLOWED_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

const trimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function nonEmptyRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : null;
}

export async function loadClaudeAgentSdk(): Promise<SdkModule> {
  if (sdkModule) return sdkModule;
  if (sdkLoadError) throw sdkLoadError;
  if (!sdkModulePromise) {
    sdkModulePromise = import("@anthropic-ai/claude-agent-sdk")
      .then((mod) => {
        sdkModule = mod;
        return mod;
      })
      .catch((error) => {
        sdkLoadError =
          error instanceof Error
            ? error
            : new Error(
                String(
                  (error as { message?: string })?.message ||
                    error ||
                    "Failed to load Claude Agent SDK",
                ),
              );
        sdkModulePromise = null;
        throw sdkLoadError;
      });
  }
  return sdkModulePromise;
}

/**
 * Copy a Claude session's chain up to `upToMessageId` into a new session
 * (fresh uuids, no side branches) and return the new id. A plain resume of
 * the copy sees exactly that history, wherever other branches went.
 */
export async function forkClaudeSession(
  sessionId: string,
  upToMessageId: string,
): Promise<string> {
  const sdk = await loadClaudeAgentSdk();
  const result = await sdk.forkSession(sessionId, { upToMessageId });
  if (!result?.sessionId) throw new Error("forkSession returned no session id");
  return result.sessionId;
}

export function resetClaudeAgentSdkCache(): void {
  sdkModule = null;
  sdkModulePromise = null;
  sdkLoadError = null;
}

export async function probeClaudeAgentSdk(): Promise<{
  available: boolean;
  error?: string;
}> {
  try {
    await loadClaudeAgentSdk();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error:
        error instanceof Error ? error.message : "Claude Agent SDK unavailable",
    };
  }
}

export function killProcessTree(
  pid: number | null | undefined,
  options: { signal?: NodeJS.Signals; force?: boolean } = {},
): void {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return;
  const signal = options.signal || "SIGTERM";
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // best-effort
    }
    return;
  }

  const kill = (target: number, killSignal: NodeJS.Signals) => {
    try {
      process.kill(target, killSignal);
    } catch {
      // ignore
    }
  };

  kill(-pid, signal);
  kill(pid, signal);
  if (options.force) {
    kill(-pid, "SIGKILL");
    kill(pid, "SIGKILL");
  }
}

export type ClaudeQueryHandle = {
  stream: AsyncIterable<unknown>;
  interrupt: () => Promise<void>;
  close: () => void;
  getPid: () => number | null | undefined;
  /**
   * Stop the turn the way Claude Code's own Esc does: interrupt, let the CLI
   * write the interruption to the transcript, then close. Resolves once the
   * process is closed. Added by withGracefulStop when missing.
   */
  stop?: (graceMs?: number) => Promise<void>;
  /** Observe every event the stream yields, including ones read by stop(). */
  onEvent?: (listener: (event: unknown) => void) => void;
};

export type StoppableClaudeQueryHandle = ClaudeQueryHandle & {
  stop: (graceMs?: number) => Promise<void>;
  onEvent: (listener: (event: unknown) => void) => void;
};

/** How long a stopped turn gets to settle after interrupt() before close. */
export function stopGraceMs(): number {
  const raw = Number(process.env.OPENCODE_CLAUDE_STOP_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_000;
}

/**
 * Give a query handle a graceful stop().
 *
 * close() kills the CLI at once: a turn parked on a tool call dies with its
 * tool_use unanswered, and a turn killed before its first write leaves a
 * session id the CLI never saved. stop() first sends the SDK interrupt, so
 * the CLI aborts the turn itself and records it ("[Request interrupted by
 * user for tool use]"), reads the stream until the turn's result (nobody
 * else reads a parked turn), and closes after that or after the grace.
 *
 * The stream is wrapped once; its iterator is shared, so events read by
 * stop() and by the proxy's consumer all pass the onEvent listeners.
 */
export function withGracefulStop(handle: ClaudeQueryHandle): StoppableClaudeQueryHandle {
  if (typeof handle.stop === "function" && typeof handle.onEvent === "function") {
    return handle as StoppableClaudeQueryHandle;
  }
  const inner = handle.stream[Symbol.asyncIterator]();
  const listeners: Array<(event: unknown) => void> = [];
  let ended = false;
  let sawResult = false;
  const observe = (event: unknown) => {
    if (event && typeof event === "object" && (event as { type?: unknown }).type === "result") {
      sawResult = true;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // a listener must never break the stream
      }
    }
  };
  const tap: AsyncIterableIterator<unknown> = {
    async next() {
      try {
        const next = await inner.next();
        if (next.done) ended = true;
        else observe(next.value);
        return next;
      } catch (error) {
        ended = true;
        throw error;
      }
    },
    async return(value?: unknown) {
      ended = true;
      if (typeof inner.return === "function") return inner.return(value);
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return tap;
    },
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    handle.close();
  };

  let stopping: Promise<void> | null = null;
  const stop = (graceMs = stopGraceMs()) => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!closed && !ended && graceMs > 0) {
        const settle = (async () => {
          try {
            await handle.interrupt();
          } catch {
            // process already gone; nothing to settle
            return;
          }
          while (!ended && !sawResult && !closed) {
            try {
              if ((await tap.next()).done) break;
            } catch {
              break;
            }
          }
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          settle,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, graceMs);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      close();
    })();
    return stopping;
  };

  return {
    stream: tap,
    interrupt: handle.interrupt,
    close,
    getPid: handle.getPid,
    stop,
    onEvent: (listener) => {
      listeners.push(listener);
    },
  };
}

export type StartClaudeQueryParams = {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  model?: string;
  resume?: string;
  /** With `resume`: resume only up to and including this entry. */
  resumeSessionAt?: string;
  /** With `resume`: continue in a new session id instead of appending. */
  forkSession?: boolean;
  permissionMode?: string;
  effort?: ClaudeEffort | string;
  systemPrompt?:
    | string
    | {
        type: "preset";
        preset: "claude_code";
        append?: string;
        /** Move cwd, memory path and git status out of the system prompt. */
        excludeDynamicSections?: boolean;
      };
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: object,
  ) => Promise<object | null>;
  env?: Record<string, string | undefined>;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, object>;
  agent?: string;
  allowedTools?: string[];
  /** Disable Claude built-in tools so OpenCode owns tool execution. */
  tools?: string[] | { type: string; [key: string]: unknown };
  /** Redirect built-in tool names to OpenCode MCP tools. */
  toolAliases?: Record<string, string>;
  disallowedTools?: string[];
  skills?: string[] | "all";
  settingSources?: Array<"user" | "project" | "local">;
  pathToClaudeCodeExecutable?: string;
  /** Required when permissionMode is bypassPermissions. */
  allowDangerouslySkipPermissions?: boolean;
  /** Auto-compact long conversations (Claude Code default). */
  autoCompactEnabled?: boolean;
  /** Stop utility queries such as title generation after one model turn. */
  maxTurns?: number;
  /** false keeps one-shot utility turns out of ~/.claude/projects history. */
  persistSession?: boolean;
  /**
   * Isolate a one-shot turn from every MCP server the user configured,
   * including claude.ai cloud connectors, so none of their tool definitions
   * ride along.
   */
  isolateMcp?: boolean;
  /** Thinking config; defaults to adaptive when effort is set. */
  thinking?:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
  queryImpl?: (mod: SdkModule) => unknown;
};

export async function startClaudeQuery(
  params: StartClaudeQueryParams,
): Promise<ClaudeQueryHandle> {
  const sdk = await loadClaudeAgentSdk();
  const queryFn =
    typeof params.queryImpl === "function"
      ? params.queryImpl(sdk)
      : (sdk as { query?: unknown }).query;

  if (typeof queryFn !== "function") {
    const error = new Error("Claude Agent SDK query() is unavailable") as Error & {
      code?: string;
      statusCode?: number;
    };
    error.code = "CLAUDE_SDK_UNAVAILABLE";
    error.statusCode = 503;
    throw error;
  }

  const env = buildClaudeCodeChildEnv(params.env || process.env);
  const cwd = assertClaudeWorkingDirectory(params.cwd);
  const pathToClaudeCodeExecutable =
    trimmedString(params.pathToClaudeCodeExecutable) ||
    (await resolveClaudeCodeExecutable({ env })) ||
    undefined;

  const options: Record<string, unknown> = {
    cwd,
    env,
    includePartialMessages: params.includePartialMessages !== false,
    settingSources: Array.isArray(params.settingSources)
      ? params.settingSources
      : ["user", "project", "local"],
  };

  if (pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    if (isJsEntrypoint(pathToClaudeCodeExecutable)) options.executable = "node";
  }

  const model = trimmedString(params.model);
  if (model) options.model = model;

  const resume = trimmedString(params.resume);
  if (resume) {
    options.resume = resume;
    const resumeAt = trimmedString(params.resumeSessionAt);
    if (resumeAt) options.resumeSessionAt = resumeAt;
    if (params.forkSession === true) options.forkSession = true;
  }

  const permissionMode = trimmedString(params.permissionMode);
  if (ALLOWED_PERMISSION_MODES.has(permissionMode)) {
    options.permissionMode = permissionMode;
  }
  if (
    params.allowDangerouslySkipPermissions === true &&
    permissionMode === "bypassPermissions"
  ) {
    options.allowDangerouslySkipPermissions = true;
  }

  const effort = trimmedString(params.effort);
  if (isClaudeEffort(effort)) options.effort = effort;

  if (params.thinking) {
    options.thinking = params.thinking;
  } else if (isClaudeEffort(effort)) {
    // Effort guides adaptive thinking depth on models that support it.
    options.thinking = { type: "adaptive" };
  }

  if (params.autoCompactEnabled !== false) {
    options.autoCompactEnabled = true;
  }

  if (params.persistSession === false) options.persistSession = false;

  const settings: Record<string, unknown> = {};
  if (params.isolateMcp === true) {
    options.strictMcpConfig = true;
    settings.disableClaudeAiConnectors = true;
  }

  // Without these the CLI streams thinking blocks empty: the UI shows nothing
  // for as long as Claude thinks (tens of seconds), then the answer lands at
  // once. Summaries stream the reasoning as it happens (same as t3code).
  if ((options.thinking as { type?: string } | undefined)?.type !== "disabled") {
    settings.showThinkingSummaries = true;
    options.extraArgs = { "thinking-display": "summarized" };
  }

  if (Object.keys(settings).length > 0) options.settings = settings;

  if (Number.isInteger(params.maxTurns) && Number(params.maxTurns) > 0) {
    options.maxTurns = params.maxTurns;
  }

  if (typeof params.canUseTool === "function") {
    options.canUseTool = params.canUseTool;
  }

  const customSystemPrompt = trimmedString(params.systemPrompt);
  const presetSystemPrompt =
    typeof params.systemPrompt === "string"
      ? null
      : nonEmptyRecord(params.systemPrompt);
  if (customSystemPrompt) {
    options.systemPrompt = customSystemPrompt;
  } else if (
    presetSystemPrompt?.type === "preset" &&
    presetSystemPrompt.preset === "claude_code"
  ) {
    const systemPrompt: {
      type: "preset";
      preset: "claude_code";
      append?: string;
      excludeDynamicSections?: boolean;
    } = { type: "preset", preset: "claude_code" };
    const append = trimmedString(presetSystemPrompt.append);
    if (append) systemPrompt.append = append;
    if (presetSystemPrompt.excludeDynamicSections === true) {
      systemPrompt.excludeDynamicSections = true;
    }
    options.systemPrompt = systemPrompt;
  } else {
    options.systemPrompt = { type: "preset", preset: "claude_code" };
  }

  if (nonEmptyRecord(params.mcpServers)) options.mcpServers = params.mcpServers;
  if (nonEmptyRecord(params.agents)) options.agents = params.agents;

  const mainAgent = trimmedString(params.agent);
  if (mainAgent) options.agent = mainAgent;

  if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
    options.allowedTools = params.allowedTools.filter(
      (tool) => typeof tool === "string" && tool.trim(),
    );
  }

  if (Array.isArray(params.disallowedTools) && params.disallowedTools.length > 0) {
    options.disallowedTools = params.disallowedTools.filter(
      (tool) => typeof tool === "string" && tool.trim(),
    );
  }

  if (params.tools !== undefined) {
    options.tools = params.tools;
  }

  if (nonEmptyRecord(params.toolAliases)) {
    options.toolAliases = params.toolAliases;
  }

  if (params.skills === "all" || Array.isArray(params.skills)) {
    options.skills = params.skills;
  } else if (params.skills === undefined) {
    options.skills = "all";
  }

  log.info("[opencode-claude] starting Claude Agent SDK query", {
    model: options.model,
    effort: options.effort,
    resume: Boolean(resume),
    cwd,
  });

  let result: any;
  try {
    result = (queryFn as (input: { prompt: unknown; options: unknown }) => unknown)({
      prompt: params.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/spawn.*ENOTDIR/i.test(message)) {
      const wrapped = new Error(
        "Claude Code executable path is not spawnable (ENOTDIR).",
      ) as Error & { code?: string; statusCode?: number; cause?: unknown };
      wrapped.code = "CLAUDE_SPAWN_ENOTDIR";
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  let closed = false;
  const getPid = () =>
    result && typeof result === "object" && "pid" in result
      ? (result.pid as number | null | undefined)
      : null;

  // Query.interrupt() is a control request: it rejects once the process is
  // gone, which callers treat as "nothing left to interrupt".
  const interrupt = async () => {
    if (result && typeof result.interrupt === "function") {
      await result.interrupt();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    killProcessTree(getPid(), { signal: "SIGTERM", force: true });
    // The SDK Query exposes no pid, so the tree-kill above is a no-op for it;
    // Query.close() is what actually ends the CLI subprocess. A parked turn
    // is not being iterated, and return() alone leaves its child running.
    if (result && typeof result.close === "function") {
      try {
        result.close();
      } catch {
        // already torn down
      }
    }
    if (result && typeof result.return === "function") {
      try {
        Promise.resolve(result.return()).catch(() => {});
      } catch {
        // ignore
      }
    }
  };

  return withGracefulStop({
    stream: result as AsyncIterable<unknown>,
    interrupt,
    close,
    getPid,
  });
}

/** Wait per model id for the CLI's context window; a stuck CLI ends the probe. */
const CONTEXT_PROBE_TIMEOUT_MS = 10_000;

export type ClaudeModelDiscovery = {
  /** The CLI's `supportedModels()` rows. */
  rows: unknown[];
  /**
   * Context window the CLI itself runs each model id with, plain and `[1m]`
   * (`getContextUsage().rawMaxTokens`); null when the CLI refused the id.
   * Ids missing here could not be asked (old CLI, timeout).
   */
  windows: Map<string, number | null>;
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ContextUsage = { rawMaxTokens?: unknown; model?: unknown };

type DiscoveryQuery = {
  supportedModels?: () => Promise<unknown[]>;
  initializationResult?: () => Promise<{
    claude_code_version?: unknown;
    account?: Record<string, unknown>;
  }>;
  setModel?: (model?: string) => Promise<void>;
  // SDK 0.3.224 takes no options and sends the full form; newer SDKs pass
  // `detail` on.
  getContextUsage?: (options?: { detail?: "summary" | "full" }) => Promise<ContextUsage>;
  close?: () => void;
};

/**
 * Window of the model the query runs now. `summary` makes the CLI answer
 * locally; the default full form also counts each part of the context
 * through the token-count API, which the window does not need.
 */
async function currentContextWindow(q: DiscoveryQuery): Promise<number | null> {
  const usage = await q.getContextUsage!({ detail: "summary" });
  const tokens = usage?.rawMaxTokens;
  return typeof tokens === "number" && tokens > 0 ? tokens : null;
}

/**
 * CLAUDE_CODE_DISABLE_1M_CONTEXT as set in the user's Claude Code
 * settings.json `env`. Read on each model-list refresh, like the variable in
 * the environment; a change shows at the next refresh. The CLI also reports
 * its merged settings through `getSettings()` (SDK 0.3.300, not in the
 * SDK's public types), which covers organization-managed settings too; the
 * documented file is used instead.
 */
export function settingsDisable1MContext(
  env: Record<string, string | undefined>,
): string | undefined {
  try {
    const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    const value = settings?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    return value === undefined || value === null ? undefined : String(value);
  } catch {
    return undefined;
  }
}

/**
 * Which CLI build runs: its real path, size and modification time. CLIs
 * before 2.1.300 do not report `claude_code_version` at initialize, and an
 * update replaces the file (the native installer and npm both do), so the
 * file tells an update apart without starting `claude --version`.
 */
export function cliFileStamp(executable: string | undefined): string | undefined {
  if (!executable) return undefined;
  try {
    const real = realpathSync(executable);
    const stat = statSync(real);
    return `${real}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * What the CLI's windows depend on besides the model id: the CLI build, the
 * account, and the 1M switch, in the environment and in settings.json.
 */
async function contextWindowKey(
  q: DiscoveryQuery,
  env: Record<string, string | undefined>,
  executable: string | undefined,
): Promise<string> {
  const init = await withTimeout(
    q.initializationResult?.() ?? Promise.resolve(undefined),
    CONTEXT_PROBE_TIMEOUT_MS,
  );
  const account = init?.value?.account ?? {};
  const parts = [
    init?.value?.claude_code_version,
    cliFileStamp(executable),
    account.email,
    account.organization,
    account.subscriptionType,
    account.apiProvider,
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
    settingsDisable1MContext(env),
  ];
  // A digest, so the cache file holds no email address.
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * Switch the idle query to `id` and read the window the CLI uses for it;
 * null when the CLI refuses the id ("Sonnet with 1M context is not available
 * for your account"), "timeout" when it stops answering.
 */
async function askContextWindow(
  q: DiscoveryQuery,
  id: string,
): Promise<number | null | "timeout"> {
  const answer = await withTimeout(
    q.setModel!(id).then(
      () => currentContextWindow(q),
      () => null,
    ),
    CONTEXT_PROBE_TIMEOUT_MS,
  );
  return answer ? answer.value : "timeout";
}

/**
 * Fill `windows` with what is missing for the listed models. The CLI answers
 * per account and per CLI version: Opus 4.6 runs at 200K and at 1M only as
 * `[1m]`, a plan without 1M access refuses `[1m]`, and
 * CLAUDE_CODE_DISABLE_1M_CONTEXT turns every model down to 200K. Returns
 * whether anything was added.
 */
export async function askMissingContextWindows(
  q: DiscoveryQuery,
  rows: SdkModelRow[],
  windows: Map<string, number | null>,
): Promise<boolean> {
  let added = false;
  for (const id of listedModelIds(rows)) {
    if (windows.has(id)) continue;
    const window = await askContextWindow(q, id);
    if (window === "timeout") return added;
    // A plain id that failed is asked again next time; the table covers it.
    if (window === null) continue;
    windows.set(id, window);
    added = true;
  }
  for (const id of extendedProbeIds(rows, windows)) {
    const window = await askContextWindow(q, id);
    if (window === "timeout") return added;
    windows.set(id, window);
    added = true;
  }
  return added;
}

/**
 * Ask the local CLI which models this account can use and the context window
 * of each. Starts a Claude Code process with no prompt and persists nothing.
 * The list costs no model request; a window not yet in the cache costs one
 * (see askContextWindow), so only those are asked.
 */
export async function listClaudeSupportedModels(
  timeoutMs = 20_000,
): Promise<ClaudeModelDiscovery | null> {
  const sdk = await loadClaudeAgentSdk();
  const queryFn = (sdk as { query?: Function }).query;
  if (typeof queryFn !== "function") return null;
  let release: () => void = () => {};
  const idle = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  const env = buildClaudeCodeChildEnv(process.env);
  const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutable({ env });
  const q = queryFn({
    prompt: idle,
    options: {
      env,
      persistSession: false,
      // The user's settings, as in a chat: CLAUDE_CODE_DISABLE_1M_CONTEXT in
      // settings.json `env` changes the windows. Their hooks stay off.
      settingSources: ["user"],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true, disableAllHooks: true },
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      ...(pathToClaudeCodeExecutable && isJsEntrypoint(pathToClaudeCodeExecutable)
        ? { executable: "node" as const }
        : {}),
    },
  }) as DiscoveryQuery;
  try {
    if (typeof q.supportedModels !== "function") return null;
    const listed = await withTimeout(q.supportedModels(), timeoutMs);
    if (!listed) return null;
    const rows = listed.value;
    const windows = new Map<string, number | null>();
    if (typeof q.setModel === "function" && typeof q.getContextUsage === "function") {
      const key = await contextWindowKey(q, env, pathToClaudeCodeExecutable ?? undefined);
      const listed = listedModelIds(rows as SdkModelRow[]);
      const cached = cacheForListedModels(readContextWindowCache(key), listed);
      for (const [id, window] of Object.entries(cached?.windows ?? {})) windows.set(id, window);
      // With a cache, only ids the CLI could not answer last time are asked.
      if (await askMissingContextWindows(q, rows as SdkModelRow[], windows)) {
        writeContextWindowCache({
          key,
          // The day starts over only when everything was asked.
          savedAt: cached?.savedAt ?? Date.now(),
          models: cached?.models ?? listed,
          windows: Object.fromEntries(windows),
        });
      }
    }
    return { rows, windows };
  } finally {
    release();
    q.close?.();
  }
}
