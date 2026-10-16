/**
 * Regression for the CLI auto-update (src/cli-update.ts):
 * - `claude update` output maps to one outcome each, and exit 0 alone is not
 *   taken for success (the CLI exits 0 when another process holds the lock);
 *   a failure reports the CLI's last line, not its "Current version" preamble,
 *   or the cause above the "claude doctor" hint, and a successful update drops
 *   the memoized CLI path;
 * - every run ends with `claude --version`, and an update or "up to date" the
 *   installed version contradicts is a failure;
 * - the periodic check runs once per interval across plugin instances, through
 *   the shared record file claimed before the run (and in memory when the file
 *   cannot be written), waits for a missing CLI, and is off under the
 *   documented switches;
 * - the run settles on `close`, so output after `exit` still counts, and on
 *   `exit` alone when a child never closes.
 *
 * Fake CLI children only (no shell scripts), so the file runs on Windows too.
 * The real CLI is exercised by test/cli-update-live.ts.
 *
 * Run: bun test/cli-update-regression.ts
 */
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assert, sleep } from "./helpers.ts";

// The plugin log follows the process's XDG_DATA_HOME: its warnings (the
// unwritable record below) go to a temp dir, not the user's debug.log.
const logHome = mkdtempSync(join(tmpdir(), "opencode-claude-update-log-"));
process.env.XDG_DATA_HOME = logHome;

async function main() {
  const {
    cliAutoUpdateDisabledReason,
    cliUpdateLogPath,
    cliUpdateRecordPath,
    parseClaudeUpdateOutput,
    readCliUpdateRecord,
    startClaudeCliAutoUpdate,
    updateClaudeCli,
  } = await import("../src/cli-update.ts");

  // Output → outcome. Lines as Claude Code 2.1.280 prints them.
  {
    assert.deepEqual(
      parseClaudeUpdateOutput("Updating to 2.1.296...\nSuccessfully updated from 2.1.280 to version 2.1.296\n"),
      { kind: "updated", from: "2.1.280", to: "2.1.296" },
    );
    assert.deepEqual(parseClaudeUpdateOutput("Claude Code is up to date (2.1.296)\n"), {
      kind: "up-to-date",
      version: "2.1.296",
    });
    // Homebrew and winget installs print it without a version.
    assert.deepEqual(parseClaudeUpdateOutput("Claude is up to date!\n"), {
      kind: "up-to-date",
      version: null,
    });
    assert.deepEqual(
      parseClaudeUpdateOutput(
        "Another Claude process (PID 4242) is currently running. Please try again in a moment.\n",
      ),
      { kind: "busy" },
    );
    assert.deepEqual(
      parseClaudeUpdateOutput("Claude is managed by winget.\nTo update, run:\n  winget upgrade Anthropic.ClaudeCode\n"),
      { kind: "package-manager" },
    );
    assert.equal(parseClaudeUpdateOutput("Failed to check for updates\n"), null);
  }

  // The real command: `<claude> update`, outcome from the output, not the exit code.
  const fakeCli = () => {
    const streams = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    const child = Object.assign(new EventEmitter(), {
      pid: 7,
      stdout: streams.stdout,
      stderr: streams.stderr,
      kill() {
        return true;
      },
    });
    return { child, streams };
  };
  // How the fake child ends: the usual order, output still arriving after
  // `exit` (pipes drain late), or `exit` with no `close` at all.
  type Ending = "normal" | "output-after-exit" | "exit-only";
  const run = async (
    lines: string,
    code: number,
    binaryPath = "/opt/claude",
    ending: Ending = "normal",
    /** What `claude --version` answers after the run. */
    installed: string | null = "2.1.296",
  ) => {
    const { child, streams } = fakeCli();
    const calls: string[][] = [];
    const versionChecks: string[] = [];
    let resets = 0;
    const pending = updateClaudeCli({
      env: { PATH: "/usr/bin" },
      binaryPath,
      spawnInstall(command, args) {
        calls.push([command, ...args]);
        return child as any;
      },
      resetResolution() {
        resets += 1;
      },
      async probeVersion(path) {
        versionChecks.push(path);
        return installed;
      },
    });
    await sleep(0);
    if (ending === "output-after-exit") {
      child.emit("exit", code);
      await sleep(30);
      streams.stdout.emit("data", lines);
      child.emit("close", code);
    } else {
      streams.stdout.emit("data", lines);
      child.emit("exit", code);
      if (ending === "normal") child.emit("close", code);
    }
    return { outcome: await pending, calls, resets, versionChecks };
  };
  // The CLI's progress lines come before the verdict in every transcript.
  const preamble = "Current version: 2.1.280\nChecking for updates to latest version...\n";
  {
    const updated = await run(`${preamble}Updating to 2.1.296...\nSuccessfully updated from 2.1.280 to version 2.1.296\n`, 0);
    assert.deepEqual(updated.outcome, { kind: "updated", from: "2.1.280", to: "2.1.296", installed: "2.1.296" });
    assert.deepEqual(updated.calls, [["/opt/claude", "update"]]);
    // The binary (and on Windows possibly its layout) changed: forget the memoized path.
    assert.equal(updated.resets, 1);
    // Every run ends with `claude --version` on the same CLI.
    assert.deepEqual(updated.versionChecks, ["/opt/claude"]);

    const busy = await run(`${preamble}Another Claude process is currently running. Please try again in a moment.\n`, 0);
    assert.deepEqual(busy.outcome, { kind: "busy", installed: "2.1.296" });
    assert.equal(busy.resets, 0);

    // The error is the last line, after the progress lines.
    const failed = await run(`${preamble}Failed to check for updates\n`, 1, "/opt/claude", "normal", "2.1.280");
    assert.deepEqual(failed.outcome, { kind: "failed", message: "Failed to check for updates", installed: "2.1.280" });
    assert.equal(failed.resets, 0);
    assert.deepEqual(failed.versionChecks, ["/opt/claude"], "a failure is checked too");

    // A failed install ends with a "claude doctor" hint; the cause is above it
    // (Claude Code 2.1.301, connection cut mid-download).
    const cut = await run(
      `${preamble}Updating to 2.1.301...\nError: Failed to install native update\nTelemetrySafeError: The connection dropped while downloading the update (attempt 3/3: aborted). Check your network — proxies sometimes cut off large downloads.\nTry running "claude doctor" for diagnostics\n`,
      1,
      "/opt/claude",
      "normal",
      "2.1.280",
    );
    assert.deepEqual(cut.outcome, {
      kind: "failed",
      message:
        "Error: Failed to install native update: TelemetrySafeError: The connection dropped while downloading the update (attempt 3/3: aborted). Check your network — proxies sometimes cut off large downloads.",
      installed: "2.1.280",
    });
    // The hint without an "Error:" line: the line before it.
    const hintOnly = await run(`${preamble}disk full\nTry running "claude doctor" for diagnostics\n`, 1);
    assert.equal(hintOnly.outcome.kind === "failed" && hintOnly.outcome.message, "disk full");

    // "Successfully updated" while the old launcher stays (Windows, launcher
    // held open during the swap): the version check turns it into a failure.
    const kept = await run(`${preamble}Successfully updated from 2.1.280 to version 2.1.296\n`, 0, "/opt/claude", "normal", "2.1.280");
    assert.deepEqual(kept.outcome, {
      kind: "failed",
      message: "claude update reported 2.1.280 -> 2.1.296, but `claude --version` reports 2.1.280",
      installed: "2.1.280",
    });
    const noAnswer = await run(`${preamble}Successfully updated from 2.1.280 to version 2.1.296\n`, 0, "/opt/claude", "normal", null);
    assert.deepEqual(noAnswer.outcome, {
      kind: "failed",
      message: "claude update reported 2.1.280 -> 2.1.296, but `claude --version` reports no version",
      installed: null,
    });
    const staleCurrent = await run(`${preamble}Claude Code is up to date (2.1.296)\n`, 0, "/opt/claude", "normal", "2.1.280");
    assert.deepEqual(staleCurrent.outcome, {
      kind: "failed",
      message: "claude update reported 2.1.296 as up to date, but `claude --version` reports 2.1.280",
      installed: "2.1.280",
    });

    // Exit 0 with unknown text is not a success either.
    const unknown = await run(`${preamble}something new\n`, 0);
    assert.deepEqual(unknown.outcome, { kind: "failed", message: "something new", installed: "2.1.296" });

    // No output at all: the exit code is all there is to report.
    const silent = await run("", 3);
    assert.deepEqual(silent.outcome, { kind: "failed", message: "claude update exited with code 3.", installed: "2.1.296" });

    const missing = await updateClaudeCli({ env: { PATH: "/usr/bin" }, binaryPath: null });
    assert.equal(missing.kind, "failed");

    // Windows npm installs may resolve to `cli.js`, which only node can run.
    const cliJs = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const viaNode = await run(`${preamble}Claude Code is up to date (2.1.296)\n`, 0, cliJs);
    assert.deepEqual(viaNode.outcome, { kind: "up-to-date", version: "2.1.296", installed: "2.1.296" });
    assert.deepEqual(viaNode.calls, [["node", cliJs, "update"]]);
    assert.equal(viaNode.resets, 0);

    // The verdict may arrive after `exit`: `close` is what settles the run.
    const lateVerdict = await run(`${preamble}Successfully updated from 2.1.280 to version 2.1.296\n`, 0, "/opt/claude", "output-after-exit");
    assert.deepEqual(lateVerdict.outcome, { kind: "updated", from: "2.1.280", to: "2.1.296", installed: "2.1.296" });

    // A child that never emits `close` still settles, on `exit` after a grace period.
    const started = Date.now();
    const exitOnly = await run(`${preamble}Claude Code is up to date (2.1.296)\n`, 0, "/opt/claude", "exit-only");
    assert.deepEqual(exitOnly.outcome, { kind: "up-to-date", version: "2.1.296", installed: "2.1.296" });
    assert.ok(Date.now() - started >= 400, "exit-only settles after the grace period");
  }

  // Switches.
  {
    assert.equal(cliAutoUpdateDisabledReason(undefined, {}), null);
    assert.equal(cliAutoUpdateDisabledReason({ cliAutoUpdate: true }, {}), null);
    assert.match(cliAutoUpdateDisabledReason({ cliAutoUpdate: false }, {}) ?? "", /cliAutoUpdate/);
    assert.match(cliAutoUpdateDisabledReason(undefined, { DISABLE_UPDATES: "1" }) ?? "", /DISABLE_UPDATES/);
    assert.match(cliAutoUpdateDisabledReason(undefined, { DISABLE_AUTOUPDATER: "true" }) ?? "", /DISABLE_AUTOUPDATER/);
    assert.match(cliAutoUpdateDisabledReason(undefined, { DISABLE_AUTOUPDATER: "ON" }) ?? "", /DISABLE_AUTOUPDATER/);
    // Claude Code's documented "off" spellings keep updates on.
    for (const off of ["0", "false", "no", "off", "Off", ""]) {
      assert.equal(cliAutoUpdateDisabledReason(undefined, { DISABLE_AUTOUPDATER: off, DISABLE_UPDATES: off }), null, `off value ${JSON.stringify(off)}`);
    }
    // Presence-only variable: even "0" means set.
    assert.match(cliAutoUpdateDisabledReason(undefined, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" }) ?? "", /NONESSENTIAL/);
    assert.equal(cliAutoUpdateDisabledReason(undefined, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" }), null);
  }

  // The periodic check: one run per interval across instances, record shared.
  const data = mkdtempSync(join(tmpdir(), "opencode-claude-update-"));
  try {
    const env = { XDG_DATA_HOME: data, OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: "200" };
    assert.equal(readCliUpdateRecord(env), null);
    const cliPresent = async () => true;

    let runs = 0;
    const update = async () => {
      runs += 1;
      return { kind: "up-to-date" as const, version: "2.1.296" };
    };

    // No CLI yet (install action may add one later): nothing runs, nothing is
    // recorded, and the timer keeps checking.
    let present = false;
    const stopMissing = startClaudeCliAutoUpdate({ env, update, cliPresent: async () => present });
    await sleep(20);
    assert.equal(runs, 0, "no CLI: no update attempt");
    assert.equal(readCliUpdateRecord(env), null, "no CLI: no record");
    present = true;
    await sleep(300);
    stopMissing();
    assert.ok(runs >= 1, "installed later: the next tick runs the update");
    runs = 0;
    rmSync(cliUpdateRecordPath(env), { force: true });

    const stopA = startClaudeCliAutoUpdate({ env, update, cliPresent });
    await sleep(20);
    assert.equal(runs, 1, "first check runs at once");
    const record = readCliUpdateRecord(env);
    assert.equal(record?.outcome.kind, "up-to-date");
    assert.equal(JSON.parse(readFileSync(cliUpdateRecordPath(env), "utf8")).outcome.version, "2.1.296");

    // A second instance sees the fresh record and does not run again.
    const stopB = startClaudeCliAutoUpdate({ env, update, cliPresent });
    await sleep(20);
    assert.equal(runs, 1, "second instance skips within the interval");
    stopB();

    // After the interval the timer runs the check again.
    await sleep(400);
    assert.ok(runs >= 2 && runs <= 4, `timer re-ran the check (${runs} runs)`);
    stopA();
    const afterStop = runs;
    await sleep(300);
    assert.equal(runs, afterStop, "stopped instance runs no more checks");

    // A successful update is recorded with both versions.
    rmSync(cliUpdateRecordPath(env), { force: true });
    const stopC = startClaudeCliAutoUpdate({
      env,
      cliPresent,
      update: async () => ({ kind: "updated" as const, from: "2.1.280", to: "2.1.296" }),
    });
    await sleep(20);
    stopC();
    assert.deepEqual(readCliUpdateRecord(env)?.outcome, {
      kind: "updated",
      from: "2.1.280",
      to: "2.1.296",
    });
    // The history file keeps updates (and failures), not the hourly "up to date".
    const history = readFileSync(cliUpdateLogPath(env), "utf8").trim().split("\n");
    assert.equal(history.length, 1, `history has one line: ${history.join(" | ")}`);
    assert.match(history[0]!, /^\d{4}-\d{2}-\d{2}T.*Z updated 2\.1\.280 -> 2\.1\.296$/);

    // A failure names the version the CLI stayed on.
    rmSync(cliUpdateRecordPath(env), { force: true });
    const stopF = startClaudeCliAutoUpdate({
      env,
      cliPresent,
      update: async () => ({ kind: "failed" as const, message: "Error: Failed to install native update: offline", installed: "2.1.280" }),
    });
    await sleep(20);
    stopF();
    const failedLine = readFileSync(cliUpdateLogPath(env), "utf8").trim().split("\n").at(-1)!;
    assert.match(failedLine, /Z failed \(CLI 2\.1\.280\): Error: Failed to install native update: offline$/);

    // The record is claimed before the run: while one instance is updating,
    // another (another server process reads the same file) skips.
    rmSync(cliUpdateRecordPath(env), { force: true });
    let release = () => {};
    let slowRuns = 0;
    const slowUpdate = () => {
      slowRuns += 1;
      return new Promise<{ kind: "up-to-date"; version: string }>((done) => {
        release = () => done({ kind: "up-to-date", version: "2.1.296" });
      });
    };
    const stopS1 = startClaudeCliAutoUpdate({ env, cliPresent, update: slowUpdate });
    await sleep(20);
    assert.deepEqual(readCliUpdateRecord(env)?.outcome, { kind: "running", pid: process.pid });
    // Longer than the 200 ms interval: the claim holds for a whole run.
    await sleep(300);
    const stopS2 = startClaudeCliAutoUpdate({ env, cliPresent, update: slowUpdate });
    await sleep(20);
    assert.equal(slowRuns, 1, "a running claim keeps other instances off");
    release();
    await sleep(20);
    assert.equal(readCliUpdateRecord(env)?.outcome.kind, "up-to-date", "the outcome replaces the claim");
    stopS1();
    stopS2();

    // The claim of a process that died mid-run expires after the longest run
    // (update timeout plus version check), not after the short interval.
    let claimRuns = 0;
    const countUpdate = async () => {
      claimRuns += 1;
      return { kind: "up-to-date" as const, version: "2.1.296" };
    };
    const claimAt = (msAgo: number) =>
      writeFileSync(
        cliUpdateRecordPath(env),
        JSON.stringify({ at: new Date(Date.now() - msAgo).toISOString(), outcome: { kind: "running", pid: 1 } }),
      );
    claimAt(60_000);
    const stopC1 = startClaudeCliAutoUpdate({ env, cliPresent, update: countUpdate });
    await sleep(20);
    stopC1();
    assert.equal(claimRuns, 0, "a minute-old claim still holds");
    claimAt(12 * 60_000);
    const stopC2 = startClaudeCliAutoUpdate({ env, cliPresent, update: countUpdate });
    await sleep(20);
    stopC2();
    assert.equal(claimRuns, 1, "an abandoned claim expires");

    // Off by option: nothing runs, nothing is recorded.
    rmSync(cliUpdateRecordPath(env), { force: true });
    let offRuns = 0;
    const stopOff = startClaudeCliAutoUpdate({
      env,
      cliPresent,
      options: { cliAutoUpdate: false },
      update: async () => {
        offRuns += 1;
        return { kind: "busy" as const };
      },
    });
    await sleep(20);
    stopOff();
    assert.equal(offRuns, 0);
    assert.equal(readCliUpdateRecord(env), null);

    // The record cannot be written (data dir is a file): the attempt still
    // counts within this process, so a second instance does not run again.
    const blocker = join(data, "not-a-dir");
    writeFileSync(blocker, "x");
    const unwritable = { XDG_DATA_HOME: join(blocker, "share"), OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: "200" };
    let unrecordedRuns = 0;
    const unrecordedUpdate = async () => {
      unrecordedRuns += 1;
      return { kind: "up-to-date" as const, version: "2.1.296" };
    };
    const stopU1 = startClaudeCliAutoUpdate({ env: unwritable, cliPresent, update: unrecordedUpdate });
    await sleep(20);
    assert.equal(unrecordedRuns, 1, "unwritable record: first instance runs");
    assert.equal(readCliUpdateRecord(unwritable), null, "unwritable record: nothing on disk");
    const stopU2 = startClaudeCliAutoUpdate({ env: unwritable, cliPresent, update: unrecordedUpdate });
    await sleep(20);
    assert.equal(unrecordedRuns, 1, "unwritable record: second instance skips within the interval");
    stopU1();
    stopU2();
    // One warning per attempt: the outcome is not written after a failed claim.
    const warnings = readFileSync(join(logHome, "opencode-claude", "debug.log"), "utf8")
      .split("\n")
      .filter((line) => line.includes("could not record the CLI update outcome"));
    assert.equal(warnings.length, 1, `one record warning: ${warnings.join(" | ")}`);

    // An old record that is still readable but can no longer be replaced
    // (read-only file on Windows, read-only dir elsewhere): the in-memory
    // count holds the next instance off as well.
    await sleep(250);
    const stuck = { XDG_DATA_HOME: join(data, "stuck"), OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: "200" };
    const stuckFile = cliUpdateRecordPath(stuck);
    mkdirSync(dirname(stuckFile), { recursive: true });
    writeFileSync(stuckFile, JSON.stringify({ at: "2026-01-01T00:00:00.000Z", outcome: { kind: "up-to-date", version: "2.1.280" } }));
    const lock = process.platform === "win32" ? stuckFile : dirname(stuckFile);
    chmodSync(lock, process.platform === "win32" ? 0o444 : 0o555);
    try {
      let stuckRuns = 0;
      const stuckUpdate = async () => {
        stuckRuns += 1;
        return { kind: "up-to-date" as const, version: "2.1.296" };
      };
      const stopK1 = startClaudeCliAutoUpdate({ env: stuck, cliPresent, update: stuckUpdate });
      await sleep(20);
      const stopK2 = startClaudeCliAutoUpdate({ env: stuck, cliPresent, update: stuckUpdate });
      await sleep(20);
      stopK1();
      stopK2();
      assert.equal(stuckRuns, 1, "unreplaceable record: the second instance skips within the interval");
      assert.equal(readCliUpdateRecord(stuck)?.at, "2026-01-01T00:00:00.000Z", "the old record stayed");
    } finally {
      chmodSync(lock, process.platform === "win32" ? 0o644 : 0o755);
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }

  // A memoized CLI path that vanished (another process updated the install)
  // is re-probed instead of reused. Windows resolves by file presence alone,
  // so a bare file stands in for the CLI; POSIX would probe it.
  if (process.platform === "win32") {
    const { resolveClaudeCli, resetClaudeCliResolutionCache } = await import("../src/executable-path.ts");
    const bin = mkdtempSync(join(tmpdir(), "opencode-claude-bin-"));
    try {
      const exe = join(bin, "claude.exe");
      writeFileSync(exe, "");
      const env = { PATH: bin, HOME: bin };
      resetClaudeCliResolutionCache();
      // The PATH walk joins with "/", so compare resolved paths.
      assert.equal(resolve((await resolveClaudeCli(env)) ?? ""), exe);
      assert.equal(resolve((await resolveClaudeCli(env)) ?? ""), exe, "memoized");
      rmSync(exe);
      assert.equal(await resolveClaudeCli(env), null, "vanished path is re-probed, not reused");
    } finally {
      resetClaudeCliResolutionCache();
      rmSync(bin, { recursive: true, force: true });
    }
  }

  console.log("ok — cli update regression passed");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => rmSync(logHome, { recursive: true, force: true }));
