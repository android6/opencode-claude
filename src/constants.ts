export const PROVIDER_ID = "claude-code";
export const DEFAULT_MODEL_ID = "sonnet";
export const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";

export const EFFORT_HEADER = "x-opencode-claude-effort";
export const SESSION_HEADER = "x-opencode-claude-session";
/** OpenCode request kind: primary, compaction, title or generate. */
export const KIND_HEADER = "x-opencode-claude-kind";
/** Active OpenCode project directory forwarded to the local Agent SDK proxy. */
export const DIRECTORY_HEADER = "x-opencode-claude-directory";
/**
 * The sessions a forked OpenCode session descends from, comma-separated,
 * nearest first: what it was forked from, what that was forked from, …
 */
export const FORK_SOURCES_HEADER = "x-opencode-claude-fork-sources";

export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ClaudeEffort = (typeof EFFORT_LEVELS)[number];

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}
