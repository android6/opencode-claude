/**
 * Regression: a forked OpenCode session (Fork from here, `opencode run
 * --fork`) starts from a fork of an ancestor's Claude session cut where its
 * history ends, instead of transferring the history as text. The text made
 * a prompt nothing shared, so every fork wrote the whole context to the
 * prompt cache again.
 *
 * The fork takes a copy of the ancestor's binding and goes through the
 * revert path, with one rule: the ancestor's session is only ever forked.
 * - Fork at an earlier turn, at the latest turn, twice from one point.
 * - The fork's later turns resume its own session; a revert inside it, also
 *   past the fork point, cuts the right session.
 * - Turns the ancestor's Claude session missed ride along as text.
 * - Fork of a fork: an ancestor that never ran Claude is skipped; one that
 *   did is used, past its own fork point too.
 * - No ancestor, an ancestor never on Claude, another history, a fork cut
 *   inside a tool step, a failed fork, a missing transcript: the history
 *   goes as text, as before.
 * - The ancestor's session file never gets a fork's turn.
 *
 * Run: bun test/fork-session-regression.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

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
  // The ancestors come from OpenCode's `fork.sessionID`, one lookup per
  // session; a failed lookup is asked again next time.
  {
    const { forkAncestorsOf, forkSourceOf } = await import("../src/index.ts");
    const forkOf: Record<string, string> = { c: "b", b: "a", self: "self", loop1: "loop2", loop2: "loop1" };
    const calls: string[] = [];
    const get = async ({ sessionID }: { sessionID: string }) => {
      calls.push(sessionID);
      if (sessionID === "broken") throw new Error("not found");
      const source = forkOf[sessionID];
      return source ? { id: sessionID, fork: { sessionID: source, boundary: {} } } : { id: sessionID, parentID: "not-a-fork" };
    };
    assert.deepEqual(await forkAncestorsOf(get, "c"), ["b", "a"]);
    assert.deepEqual(await forkAncestorsOf(get, "c"), ["b", "a"]);
    assert.deepEqual(calls, ["c", "b", "a"]);
    assert.deepEqual(await forkAncestorsOf(get, "plain"), []);
    assert.deepEqual(await forkAncestorsOf(get, "self"), []);
    assert.deepEqual(await forkAncestorsOf(get, "loop1"), ["loop2"]);
    assert.equal(await forkSourceOf(get, "broken"), null);
    assert.equal(await forkSourceOf(get, "broken"), null);
    assert.equal(calls.filter((id) => id === "broken").length, 2);
  }

  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-fork-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  // Transcript entries per Claude session, each chained to the one before.
  const files = new Map<string, string[]>();
  const writeTranscript = (session: string) => {
    const uuids = files.get(session) ?? [];
    writeFileSync(
      join(projectDir, `${session}.jsonl`),
      uuids
        .map((uuid, i) => JSON.stringify({ type: "assistant", uuid, parentUuid: i > 0 ? uuids[i - 1] : null }))
        .join("\n") + "\n",
    );
  };
  const append = (session: string, ...uuids: string[]) => {
    files.set(session, [...(files.get(session) ?? []), ...uuids]);
    writeTranscript(session);
  };

  const { port, proxy } = await startMockedProxy("fork-session");
  const { getForeignSessionId, getSessionTurns, inheritSessionBinding } = await import("../src/session-store.ts");

  // Forks copy the chain up to the leaf with fresh uuids.
  const forks: string[] = [];
  let failFork = false;
  proxy.setClaudeSessionForker(async (id, at) => {
    if (failFork) throw new Error("fork failed");
    const fork = `fork-${forks.length + 1}`;
    forks.push(`${id}@${at}`);
    const source = files.get(id) ?? [];
    append(fork, ...source.slice(0, source.indexOf(at) + 1).map((uuid) => `${fork}-${uuid}`));
    return fork;
  });

  let spawns = 0;
  let seen: StartClaudeQueryParams | null = null;
  // A turn that answers and moves the session's leaf to `leaf`.
  const answering = (leaf: string) =>
    proxy.setClaudeQueryStarter(async (params) => {
      spawns += 1;
      seen = params;
      const session = params.resume ?? `fresh-${spawns}`;
      append(session, leaf);
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: session };
          yield { type: "assistant", uuid: leaf, session_id: session, parent_tool_use_id: null, message: { content: [] } };
          yield textDelta(`answer ${leaf}`);
          yield { type: "result", is_error: false, usage: {}, session_id: session };
        })(),
      );
    });
  const turn = async (chat: string, leaf: string, messages: unknown[], ancestors?: string) => {
    answering(leaf);
    const forksBefore = forks.length;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": chat,
        ...(ancestors ? { "x-opencode-claude-fork-sources": ancestors } : {}),
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages }),
    });
    assert.equal(res.status, 200, `turn ${leaf}`);
    await res.text();
    const text = await promptText(seen!.prompt);
    return {
      resume: seen!.resume,
      fork: forks.length > forksBefore ? forks.at(-1) : undefined,
      transferred: /<conversation_history>/.test(text),
      text,
    };
  };
  const brief = (r: Awaited<ReturnType<typeof turn>>) => ({ resume: r.resume, fork: r.fork, transferred: r.transferred });
  const asText = { resume: undefined, fork: undefined, transferred: true };

  try {
    // The parent chat: two turns on one Claude session.
    await turn("parent", "L1", [user("load")]);
    const P = getForeignSessionId("parent")!;
    let r = await turn("parent", "L2", [user("load"), assistant("ready"), user("q1")]);
    assert.deepEqual(brief(r), { resume: P, fork: undefined, transferred: false });
    const parentTurns = JSON.stringify(getSessionTurns("parent"));
    const afterLoad = [user("load"), assistant("ready")];
    const afterQ1 = [...afterLoad, user("q1"), assistant("a1")];

    // Fork after the first answer: a fork of the parent's session cut at L1.
    r = await turn("branch-1", "B1", [...afterLoad, user("q2")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-1", fork: `${P}@L1`, transferred: false });
    assert.equal(r.text, "q2");
    assert.equal(getForeignSessionId("branch-1"), "fork-1");

    // A second fork of the same point gets its own copy.
    r = await turn("branch-2", "B2", [...afterLoad, user("q3")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-2", fork: `${P}@L1`, transferred: false });

    // The fork's next turn resumes its own session.
    r = await turn("branch-1", "B1b", [...afterLoad, user("q2"), assistant("b1"), user("q2 more")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-1", fork: undefined, transferred: false });
    // A revert inside the fork goes back to its own copy of the fork point.
    r = await turn("branch-1", "B1c", [...afterLoad, user("q2 again")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-3", fork: "fork-1@fork-1-L1", transferred: false });

    // Fork after the parent's latest answer: cut at the latest leaf.
    r = await turn("branch-3", "B3", [...afterQ1, user("q4")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-4", fork: `${P}@L2`, transferred: false });
    // A revert past the fork point: the boundary lives in the parent's
    // session, so the cut is made there.
    r = await turn("branch-3", "B3b", [...afterLoad, user("q4 earlier")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-5", fork: `${P}@L1`, transferred: false });

    // A turn the parent's Claude session never saw (another model answered
    // it) comes along as the missed part.
    r = await turn("branch-4", "B4", [...afterQ1, user("q5"), assistant("other model"), user("q6")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-6", fork: `${P}@L2`, transferred: true });
    assert.match(r.text, /added to this chat after your last turn/);
    assert.match(r.text, /q5/);
    assert.doesNotMatch(r.text, /User:\nload/);

    // Fork of a fork that never ran Claude: the next ancestor is used.
    r = await turn("grand-1", "G1", [...afterLoad, user("q7")], "mid-unused,parent");
    assert.deepEqual(brief(r), { resume: "fork-7", fork: `${P}@L1`, transferred: false });

    // Fork of a fork that did: its own turns and, before its fork point,
    // the parent's.
    r = await turn("mid", "M1", [...afterQ1, user("m1")], "parent");
    assert.deepEqual(brief(r), { resume: "fork-8", fork: `${P}@L2`, transferred: false });
    r = await turn("grand-2", "G2", [...afterQ1, user("m1"), assistant("m1 answer"), user("q8")], "mid,parent");
    assert.deepEqual(brief(r), { resume: "fork-9", fork: "fork-8@M1", transferred: false });
    r = await turn("grand-3", "G3", [...afterLoad, user("q9")], "mid,parent");
    assert.deepEqual(brief(r), { resume: "fork-10", fork: `${P}@L1`, transferred: false });

    // A start that copied the binding but never forked (the process died):
    // the next turn still forks instead of resuming the parent's session.
    assert.ok(inheritSessionBinding("half", "parent"));
    r = await turn("half", "H1", [...afterLoad, user("q10")]);
    assert.deepEqual(brief(r), { resume: "fork-11", fork: `${P}@L1`, transferred: false });

    // Without ancestors the fork transfers its history, as before.
    r = await turn("branch-5", "B5", [...afterLoad, user("q11")]);
    assert.deepEqual(brief(r), asText);
    // An ancestor never on Claude, or the fork's own id.
    r = await turn("branch-6", "B6", [...afterLoad, user("q12")], "unknown-parent");
    assert.deepEqual(brief(r), asText);
    r = await turn("branch-7", "B7", [...afterLoad, user("q13")], "branch-7");
    assert.deepEqual(brief(r), asText);
    // A history that is not the parent's (an early message differs).
    r = await turn("branch-8", "B8", [user("other load"), assistant("ready"), user("q14")], "parent");
    assert.deepEqual(brief(r), asText);
    assert.ok(getForeignSessionId("branch-8")?.startsWith("fresh-"), "binds to the session it starts");

    // A fork cut inside a tool step: the parent's boundary is the end of
    // that turn, more than the fork holds.
    const call = { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } };
    r = await turn(
      "branch-9",
      "B9",
      [...afterLoad, user("q1"), { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "call_1", content: "x" }, user("q15")],
      "parent",
    );
    assert.equal(r.fork, undefined);
    assert.equal(r.resume, undefined);

    // The fork fails: the history goes as text.
    failFork = true;
    r = await turn("branch-10", "B10", [...afterLoad, user("q16")], "parent");
    assert.deepEqual(brief(r), asText);
    assert.ok(getForeignSessionId("branch-10")?.startsWith("fresh-"));
    failFork = false;

    // No fork ever wrote to the parent's session or binding.
    assert.deepEqual(files.get(P), ["L1", "L2"]);
    assert.equal(getForeignSessionId("parent"), P);
    assert.equal(JSON.stringify(getSessionTurns("parent")), parentTurns);

    // The parent's transcript is gone: nothing to fork from.
    rmSync(join(projectDir, `${P}.jsonl`));
    r = await turn("branch-11", "B11", [...afterLoad, user("q17")], "parent");
    assert.deepEqual(brief(r), asText);
  } finally {
    proxy.setClaudeQueryStarter(null);
    proxy.setClaudeSessionForker(null);
    await proxy.stopProxy();
  }
  console.log("ok — fork session regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
