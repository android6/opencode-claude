/**
 * Regressions for prompt conversion and the rate-limit gate:
 * - a limit error after an unrelated `allowed` window event blocks only for
 *   the short fallback, never until that window's (days-away) reset;
 * - hours-only ("resets 5pm (UTC)") and midnight reset times parse;
 * - PDFs in tool results are forwarded, URL media leaves a note;
 * - an answered user message never becomes the prompt again.
 *
 * Ported from the fork's 62a8f7c (its transcript-truncation and meta
 * classification cases cover changes not ported here).
 *
 * Run: bun test/prompt-ratelimit-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  latestUserPrompt,
  priorMessagesOf,
  openaiToolResultToMcpContent,
  SYNTHETIC_TOOL_MEDIA_PROMPT,
} from "../src/prompt.ts";
import {
  isClaudeRateLimitText,
  parseResetTimeFromText,
  recordRateLimitErrorText,
  recordRateLimitInfo,
} from "../src/rate-limit.ts";

const MINUTE = 60_000;

async function main() {
  // The store path is resolved per call, so setting it here isolates the run.
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-prompt-rl-"));
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

  try {
    // --- Rate limit: unrelated window reset never becomes the block deadline
    const nowSec = Math.floor(Date.now() / 1000);
    recordRateLimitInfo({
      status: "allowed",
      rateLimitType: "seven_day",
      resetsAt: nowSec + 5 * 24 * 3600,
    });
    const before = Date.now();
    const blocked = recordRateLimitErrorText(
      "API Error: 429 rate limit exceeded, please retry",
    );
    assert.ok(blocked?.limited, "limit text must still block");
    assert.ok(
      blocked!.limitedUntil! <= Date.now() + 10 * MINUTE,
      `block must not extend to the seven_day reset: ${new Date(blocked!.limitedUntil!).toISOString()}`,
    );
    assert.ok(blocked!.limitedUntil! >= before + 9 * MINUTE);

    // A recent `rejected` event does vouch for its reset.
    rmSync(process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE!, { force: true });
    const rejectedReset = nowSec + 3 * 3600;
    recordRateLimitInfo({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: rejectedReset,
    });
    const hard = recordRateLimitErrorText("You've hit your session limit");
    assert.equal(hard!.limitedUntil, rejectedReset * 1000);

    // A stray "429" is not a limit message, but an API 429 is.
    assert.equal(recordRateLimitErrorText("upstream returned 429"), null);
    assert.equal(isClaudeRateLimitText("wrote 4290 bytes, line 429"), false);
    assert.equal(isClaudeRateLimitText("API Error: 429 Internal hiccup"), true);
    assert.equal(
      isClaudeRateLimitText(
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      ),
      true,
    );
    assert.equal(isClaudeRateLimitText('{"error":{"type":"rate_limit_error"}}'), true);
    assert.equal(
      isClaudeRateLimitText("You've hit your weekly limit · resets Oct 6, 1pm (UTC)"),
      true,
    );

    // --- Reset parsing: hours-only and midnight (every 5-minute scan phase)
    const base = Date.UTC(2026, 0, 1, 10, 0);
    const fivePm = parseResetTimeFromText("You've hit your session limit · resets 5pm (UTC)", base);
    assert.ok(fivePm !== undefined, "hours-only reset must parse");
    assert.ok(Math.abs(fivePm! - Date.UTC(2026, 0, 1, 17, 0)) <= 2 * MINUTE);
    const midnight = Date.UTC(2026, 0, 2, 0, 0);
    for (let phase = 0; phase < 5; phase++) {
      const now = Date.UTC(2026, 0, 1, 20, phase);
      for (const text of ["resets 12am (UTC)", "resets 12:00am (UTC)"]) {
        const parsed = parseResetTimeFromText(text, now);
        assert.ok(parsed !== undefined, `${text} missed at phase ${phase}`);
        assert.ok(Math.abs(parsed! - midnight) <= 2 * MINUTE, `${text} phase ${phase}`);
      }
    }

    // Time-only resets land on the exact wall time, never minutes early.
    for (let phase = 0; phase < 7; phase++) {
      const now = Date.UTC(2026, 8, 26, 12, phase); // 15:0x in Kyiv (UTC+3)
      const kyiv = parseResetTimeFromText("resets 11:59pm (Europe/Kyiv)", now);
      assert.equal(kyiv, Date.UTC(2026, 8, 26, 20, 59), `Kyiv phase ${phase}`);
    }
    // Already past today → tomorrow.
    assert.equal(
      parseResetTimeFromText("resets 9:30am (UTC)", Date.UTC(2026, 8, 26, 10, 0)),
      Date.UTC(2026, 8, 27, 9, 30),
    );

    // --- Transcript: output after a stand-in user message is not dropped
    const standIn = [
      { role: "user", content: "FIRST" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "SECOND" },
      { role: "assistant", content: "LOOKING", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      {
        role: "user",
        content: [
          { type: "text", text: SYNTHETIC_TOOL_MEDIA_PROMPT },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    assert.equal(latestUserPrompt(standIn), "SECOND");
    assert.ok(
      priorMessagesOf(standIn).some((m) => m.content === "LOOKING"),
      "assistant step after the stand-in must reach the transcript",
    );
    // A normal new turn still keeps its message out of the transcript.
    assert.deepEqual(
      priorMessagesOf(standIn.slice(0, 3)).map((m) => m.content),
      ["FIRST", "first answer"],
    );

    // --- Tool results: PDFs forwarded, URL media noted, never dropped
    const toolResult = openaiToolResultToMcpContent([
      { type: "text", text: "Read report.pdf" },
      {
        type: "file",
        file: { filename: "report.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQ=" },
      },
      { type: "image_url", image_url: { url: "https://example.com/chart.png" } },
    ]);
    const pdf = toolResult.find((b) => b.type === "resource");
    assert.ok(pdf && pdf.type === "resource", "PDF must be forwarded");
    assert.equal(pdf.resource.mimeType, "application/pdf");
    assert.equal(pdf.resource.blob, "JVBERi0xLjQ=");
    assert.ok(
      toolResult.some(
        (b) => b.type === "text" && b.text.includes("https://example.com/chart.png"),
      ),
      "URL image must leave a note",
    );

    // --- Prompt: newest real user message only
    assert.equal(
      latestUserPrompt([
        { role: "user", content: "OLD-QUESTION" },
        { role: "assistant", content: "answered" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "file:///tmp/shot.png" } }],
        },
      ]).toString().includes("OLD-QUESTION"),
      false,
      "must not fall back to an answered user message",
    );
    const unrelayable = latestUserPrompt([
      { role: "user", content: "OLD-QUESTION" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "file:///tmp/shot.png" } }],
      },
    ]);
    assert.equal(typeof unrelayable, "string");
    assert.match(unrelayable as string, /could not be relayed/);
    assert.equal(
      latestUserPrompt([
        { role: "user", content: "REAL-ASK" },
        { role: "assistant", content: "Reading the screenshot." },
        { role: "tool", content: "done" },
        {
          role: "user",
          content: [
            { type: "text", text: SYNTHETIC_TOOL_MEDIA_PROMPT },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ]),
      "REAL-ASK",
      "synthetic tool-media message is not a user turn",
    );

    await sdkRateLimitFlag();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("ok — prompt/rate-limit regression passed");
}

/**
 * An SDK assistant event flagged `error: "rate_limit"` is a limit whatever
 * its text says: 429 + Retry-After before the stream, the retryable stream
 * error after content.
 */
async function sdkRateLimitFlag() {
  const { startMockedProxy, mockHandle, textDelta } = await import("./helpers.ts");
  const { post, proxy } = await startMockedProxy("sdk-rl");
  const store = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE!;
  const limited = (withContent: boolean) =>
    proxy.setClaudeQueryStarter(async () =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "rl-sess" };
          if (withContent) yield textDelta("partial");
          yield {
            type: "assistant",
            error: "rate_limit",
            message: { role: "assistant", content: [{ type: "text", text: "Server is busy, try again soon" }] },
          };
          yield { type: "result", is_error: true, result: "Server is busy, try again soon" };
        })(),
      ),
    );
  try {
    limited(false);
    const pre = await post("rl-pre", { messages: [{ role: "user", content: "hi" }] });
    assert.equal(pre.status, 429);
    assert.ok(Number(pre.headers.get("retry-after")) > 0);

    rmSync(store, { force: true });
    limited(true);
    const mid = await post("rl-mid", { stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(mid.status, 200);
    const body = await mid.text();
    assert.match(body, /partial/);
    assert.match(body, /claude_session_limit/);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
