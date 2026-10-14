/**
 * Claude Code model catalog (from OpenChamber harness registry).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * 1M context rules per model family, used only when the CLI could not report
 * its windows (old CLI, timeout). Claude Code selects 1M through a `[1m]`
 * suffix on the model id; the suffix never reaches the API.
 * - optional: the plain id runs at 200K, the `[1m]` variant at 1M
 * - fixed: the plain id already runs at 1M
 * Any other model is listed at 200K.
 */
const ONE_M_FAMILIES: Array<{ match: RegExp; mode: "optional" | "fixed" }> = [
  { match: /^claude-(opus|sonnet)-4-6/, mode: "optional" },
  { match: /^claude-opus-4-[78]/, mode: "fixed" },
  { match: /^claude-(fable|opus|sonnet|haiku)-5/, mode: "fixed" },
];

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

/** Ids whose context window the CLI is asked for: every listed model, plain and `[1m]`. */
export function contextProbeIds(rows: SdkModelRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const base = rowBaseId(row);
    if (!base) continue;
    for (const id of [base, `${base}[1m]`]) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
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
 * Map the CLI's own model list (supportedModels) into the catalog, with the
 * context window the CLI reported for each id. A model gets a second "(1M)"
 * entry only when its `[1m]` variant runs a larger window than the plain id
 * (Opus 4.6); a refused `[1m]` variant is not listed.
 */
export function modelsFromSdk(
  rows: SdkModelRow[],
  windows?: ReadonlyMap<string, number | null>,
): ClaudeModel[] {
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
    const plain = windows?.get(base);
    if (typeof plain === "number") {
      out.push(model(base, name, limitFor(plain), undefined, efforts));
      const extended = windows?.get(`${base}[1m]`);
      if (typeof extended === "number" && extended > plain) {
        out.push(model(`${base}[1m]`, `${name} (1M)`, limitFor(extended), undefined, efforts));
      }
      continue;
    }
    const rule = ONE_M_FAMILIES.find((f) => f.match.test(base));
    if (rule?.mode === "fixed") {
      out.push(model(base, name, LIMIT_1M, undefined, efforts));
    } else if (rule?.mode === "optional") {
      out.push(model(base, name, LIMIT_200K, undefined, efforts));
      out.push(model(`${base}[1m]`, `${name} (1M)`, LIMIT_1M, undefined, efforts));
    } else if (/\[1m\]$/i.test(value)) {
      // An unknown model the CLI itself lists as its 1M variant.
      out.push(model(`${base}[1m]`, name, LIMIT_1M, undefined, efforts));
    } else {
      out.push(model(base, name, LIMIT_200K, undefined, efforts));
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

function modelCachePath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "models.json");
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
