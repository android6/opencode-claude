/**
 * Claude Code model catalog (from OpenChamber harness registry).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  EFFORT_LEVELS,
  isClaudeEffort,
  type ClaudeEffort,
} from "./constants.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
  /** Effort levels the model accepts; defaults to all when reasoning. */
  efforts?: ClaudeEffort[];
};

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;

function model(
  id: string,
  name: string,
  limit: { context: number; output: number },
  resolvedId?: string,
  efforts: ClaudeEffort[] = [...EFFORT_LEVELS],
): ClaudeModel {
  return {
    id,
    name,
    reasoning: efforts.length > 0,
    contextWindow: limit.context,
    maxTokens: limit.output,
    efforts,
    ...(resolvedId ? { resolvedId } : {}),
  };
}

/**
 * Fallback catalog for before the CLI has reported its own list (first
 * start, CLI missing or signed out). Same concrete ids as discovery.
 * OpenCode only runs listed models, so a session that picked a 1.0 alias
 * (`opus[1m]`, `sonnet`) asks the user to pick a model once.
 */
const FALLBACK_MODELS: ClaudeModel[] = [
  model("claude-opus-5-5", "Opus 5.5", LIMIT_1M),
  model("claude-fable-5-1", "Fable 5.1", LIMIT_1M),
  model("claude-sonnet-5-5", "Sonnet 5.5", LIMIT_1M),
  model("claude-sonnet-5", "Sonnet 5", LIMIT_1M),
  model("claude-haiku-5-5", "Haiku 5.5", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K, undefined, []),
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
];

/** A row of the Agent SDK's `supportedModels()` answer. */
export type SdkModelRow = {
  value: string;
  displayName?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
};

/** Output limit that goes with a context window. */
function limitFor(context: number): { context: number; output: number } {
  const output = context > LIMIT_200K.context ? LIMIT_1M.output : LIMIT_200K.output;
  return { context, output };
}

/** Concrete model id of a `supportedModels()` row, without `[1m]`. */
function rowBaseId(row: SdkModelRow): string | undefined {
  const value = typeof row?.value === "string" ? row.value.trim() : "";
  // The CLI's "default" row only repeats another model.
  if (!value || value === "default") return undefined;
  return (row.resolvedModel || value).replace(/\[1m\]$/i, "");
}

/** Concrete ids of the listed models, without `[1m]`, each once. */
export function listedModelIds(rows: SdkModelRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const base = rowBaseId(row);
    if (base && !ids.includes(base)) ids.push(base);
  }
  return ids;
}

/**
 * `[1m]` variants worth asking the CLI about: only where the plain id runs
 * below 1M (Opus 4.6). A model that already runs at 1M gains nothing from
 * the suffix, and every question costs a model request.
 */
export function extendedProbeIds(
  rows: SdkModelRow[],
  windows: ReadonlyMap<string, number | null>,
): string[] {
  return listedModelIds(rows)
    .filter((id) => {
      const plain = windows.get(id);
      return typeof plain === "number" && plain < LIMIT_1M.context && !windows.has(`${id}[1m]`);
    })
    .map((id) => `${id}[1m]`);
}

/**
 * Display name from the concrete model id ("claude-opus-5-5[1m]" →
 * "Opus 5.5"). CLI display names depend on the CLI version ("Opus (1M
 * context)" can mean Opus 5 or 5.5), so the id is the source of truth.
 */
export function modelNameFromId(id: string | undefined): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(
    id?.trim() ?? "",
  );
  if (!match) return undefined;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/**
 * Map the CLI's own model list (supportedModels) into the catalog. The
 * context window of each id is the one the CLI reported now (`windows`); an
 * id it could not answer this time keeps what it reported before
 * (`lastAnswers`, from the window cache), and an id it never answered gets
 * 200K, which can only compact a chat early, never overflow it. Claude Code
 * selects 1M through a `[1m]` suffix on the model id (the suffix never
 * reaches the API); a model gets a second "(1M)" entry only when its `[1m]`
 * variant runs a larger window than the plain id (Opus 4.6), and a refused
 * variant is not listed.
 */
export function modelsFromSdk(
  rows: SdkModelRow[],
  windows?: ReadonlyMap<string, number | null>,
  lastAnswers?: ReadonlyMap<string, number | null>,
): ClaudeModel[] {
  const answer = (id: string) => {
    const now = windows?.get(id);
    return now === undefined ? lastAnswers?.get(id) : now;
  };
  const out: ClaudeModel[] = [];
  for (const row of rows) {
    // The concrete id, like t3code: a session stays on the model it picked
    // instead of moving when the CLI's `opus` alias points somewhere new.
    const base = rowBaseId(row);
    if (!base) continue;
    const value = row.value.trim();
    const efforts = (row.supportedEffortLevels ?? []).filter(isClaudeEffort);
    const name =
      modelNameFromId(row.resolvedModel) ??
      modelNameFromId(value) ??
      (row.displayName?.trim() || value);
    const answered = answer(base);
    const plain = typeof answered === "number" ? answered : LIMIT_200K.context;
    out.push(model(base, name, limitFor(plain), undefined, efforts));
    // null: the CLI refused the variant for this account. Not answered this
    // time: its last answer keeps the variant, so a session on it keeps its
    // model until the next refresh asks again.
    const extended = answer(`${base}[1m]`);
    if (typeof extended === "number" && extended > plain) {
      out.push(model(`${base}[1m]`, `${name} (1M)`, limitFor(extended), undefined, efforts));
    }
  }
  // An alias row and its concrete row resolve to the same model.
  const seen = new Set<string>();
  return out.filter((m) => !seen.has(m.id) && seen.add(m.id));
}

let discovered: ClaudeModel[] | null = readCachedModels();

function buildCatalog(): ClaudeModel[] {
  return discovered?.length ? discovered : FALLBACK_MODELS;
}

export function getClaudeModels(): ClaudeModel[] {
  return buildCatalog();
}

/** Replace the discovered list and remember it for the next start. */
export function setDiscoveredModels(models: ClaudeModel[]): boolean {
  if (!models.length) return false;
  const changed = JSON.stringify(models) !== JSON.stringify(discovered);
  discovered = models;
  if (changed) writeCachedModels(models);
  return changed;
}

function dataFilePath(name: string): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", name);
}

function modelCachePath(): string {
  return dataFilePath("models.json");
}

/**
 * Context windows the CLI reported, by model id; null means the CLI refused
 * the id (a `[1m]` variant the plan does not include). Asking costs a model
 * request per id (`setModel` checks a new model with a one-token call), so
 * answers are kept while `key` stays the same (CLI version, account, the
 * 1M switch) and the CLI lists no new model, and for a day at most: the day
 * also catches what Anthropic changes on its side without a new CLI, such
 * as 1M access for the account.
 */
export type ContextWindowCache = {
  key: string;
  savedAt: number;
  /** The listed models the windows were taken for. */
  models: string[];
  windows: Record<string, number | null>;
};

const CONTEXT_WINDOW_CACHE_TTL_MS = 24 * 60 * 60_000;

/** The stored windows if they were taken under `key` less than a day ago. */
export function readContextWindowCache(
  key: string,
  now = Date.now(),
): ContextWindowCache | null {
  try {
    const parsed = JSON.parse(
      readFileSync(dataFilePath("context-windows.json"), "utf8"),
    ) as Partial<ContextWindowCache>;
    if (parsed.key !== key || typeof parsed.savedAt !== "number") return null;
    // A savedAt in the future means the clock moved back: ask again.
    if (parsed.savedAt > now || now - parsed.savedAt >= CONTEXT_WINDOW_CACHE_TTL_MS) return null;
    if (!parsed.windows || typeof parsed.windows !== "object") return null;
    if (!Array.isArray(parsed.models)) return null;
    return { key, savedAt: parsed.savedAt, models: parsed.models, windows: parsed.windows };
  } catch {
    return null;
  }
}

/**
 * Every window the CLI ever reported and the cache still holds, whatever its
 * key or age: the answer to fall back on when the CLI cannot answer now.
 * Unlike the menu in models.json, it never holds a guess.
 */
export function readLastContextWindows(): Map<string, number | null> {
  try {
    const parsed = JSON.parse(
      readFileSync(dataFilePath("context-windows.json"), "utf8"),
    ) as Partial<ContextWindowCache>;
    const answers = new Map<string, number | null>();
    for (const [id, window] of Object.entries(parsed.windows ?? {})) {
      if (typeof window === "number" || window === null) answers.set(id, window);
    }
    return answers;
  } catch {
    return new Map();
  }
}

/**
 * The cache, or null when the CLI lists a model it was not taken for. A new
 * model can come with changes to the others (a CLI or catalog update), so
 * everything is asked again rather than the new model alone.
 */
export function cacheForListedModels(
  cache: ContextWindowCache | null,
  listed: string[],
): ContextWindowCache | null {
  if (!cache) return null;
  return listed.every((id) => cache.models.includes(id)) ? cache : null;
}

export function writeContextWindowCache(cache: ContextWindowCache): void {
  try {
    const file = dataFilePath("context-windows.json");
    mkdirSync(dirname(file), { recursive: true });
    // Whole file or nothing: two OpenCode servers can write it at once.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(cache, null, 2));
    renameSync(temp, file);
  } catch {
    // Without the file the windows are asked again next time.
  }
}

function readCachedModels(): ClaudeModel[] | null {
  try {
    const parsed = JSON.parse(readFileSync(modelCachePath(), "utf8"));
    return Array.isArray(parsed) && parsed.length ? (parsed as ClaudeModel[]) : null;
  } catch {
    return null;
  }
}

function writeCachedModels(models: ClaudeModel[]): void {
  try {
    const file = modelCachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(models, null, 2));
  } catch {
    // The cache only speeds up the next start.
  }
}

export function resolveClaudeModelId(modelId: string): string {
  const match = getClaudeModels().find((m) => m.id === modelId);
  if (!match) return modelId;
  return match.resolvedId || match.id;
}

/**
 * Effort levels offered as OpenCode model variants. The variant id is the
 * effort; the model.request hook turns it into the proxy's effort header.
 */
export function buildEffortVariants(model: ClaudeModel): ClaudeEffort[] {
  if (!model.reasoning) return [];
  return model.efforts ? [...model.efforts] : [...EFFORT_LEVELS];
}
