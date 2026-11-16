import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_USED_FILE,
  LEASE_DIR_NAME,
  acquireCodexHomeLease,
  inspectCodexHomeLeases,
  pruneSupersededCodexHomes,
  removeIdleCodexHomeTemp,
  resolveCodexHomeLifecycleOptions,
} from "./codex-home-lifecycle.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const digest = (n: number) => n.toString(16).padStart(64, "0");

describe("generated Codex home lifecycle", () => {
  let root: string;
  let companyHomeRoot: string;
  let agentRoot: string;
  const agentId = "agent-1";
  let clock: number;
  const opts = () => ({ now: () => clock });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-home-lifecycle-")));
    companyHomeRoot = path.join(root, "companies/c1/codex-home");
    agentRoot = path.join(companyHomeRoot, "skill-runtimes", agentId);
    await fs.mkdir(agentRoot, { recursive: true });
    clock = Date.now();
  });
  afterEach(async () => {
    await fs.chmod(agentRoot, 0o755).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A home as Codex leaves it: plugin clone in .tmp, a session, sqlite state. */
  async function makeHome(n: number, idleMs: number) {
    const home = path.join(agentRoot, digest(n));
    await fs.mkdir(path.join(home, ".tmp/plugins"), { recursive: true });
    await fs.writeFile(path.join(home, ".tmp/plugins/marketplace.json"), "{}");
    await fs.writeFile(path.join(home, ".tmp/plugins.sync.lock"), "");
    await fs.mkdir(path.join(home, "sessions/2026/11/10"), { recursive: true });
    await fs.writeFile(path.join(home, "sessions/2026/11/10/rollout.jsonl"), "{}\n");
    await fs.writeFile(path.join(home, "state_5.sqlite"), "sqlite");
    await fs.writeFile(path.join(home, "config.toml"), "");
    await setIdle(home, idleMs);
    return home;
  }
  /** Backdate every entry (except disposable .tmp) so the home looks idle for `idleMs`. */
  async function setIdle(home: string, idleMs: number) {
    const t = new Date(clock - idleMs);
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        await fs.lutimes(full, t, t).catch(() => undefined);
      }
    };
    await walk(home);
    await fs.utimes(home, t, t);
  }
  const prune = (current?: number, extra: Parameters<typeof pruneSupersededCodexHomes>[1] = {}) =>
    pruneSupersededCodexHomes(
      { companyHomeRoot, agentId, current: current === undefined ? null : { kind: "skill-runtimes", digest: digest(current) } },
      { ...opts(), ...extra },
    );
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  it("clears only the plugin clone of an idle superseded home and keeps session state", async () => {
    const idleHome = await makeHome(1, 2 * HOUR);
    const recentHome = await makeHome(2, 5 * 60 * 1000);
    const current = await makeHome(3, 3 * DAY);
    const report = await prune(3);
    expect(report.tempRemoved).toEqual([digest(1)]);
    expect(await exists(path.join(idleHome, ".tmp"))).toBe(false);
    expect(await exists(path.join(idleHome, "sessions/2026/11/10/rollout.jsonl"))).toBe(true);
    expect(await exists(path.join(idleHome, "state_5.sqlite"))).toBe(true);
    expect(await exists(path.join(recentHome, ".tmp/plugins"))).toBe(true); // inside the grace period
    expect(await exists(path.join(current, ".tmp/plugins"))).toBe(true); // the home in use now is never touched
    expect(report.homesRemoved).toEqual([]);
  });

  it("removes a whole home only after the retention period, and not while any session file is recent", async () => {
    const expired = await makeHome(1, 8 * DAY);
    const topLevelOldButSessionRecent = await makeHome(2, 8 * DAY);
    // The directory's own mtime is old, but a session was written yesterday.
    const live = path.join(topLevelOldButSessionRecent, "sessions/2026/11/10/rollout.jsonl");
    await fs.utimes(live, new Date(clock - DAY), new Date(clock - DAY));
    const withinRetention = await makeHome(3, 3 * DAY);
    const report = await prune(99);
    expect(report.homesRemoved).toEqual([digest(1)]);
    expect(await exists(expired)).toBe(false);
    expect(await exists(topLevelOldButSessionRecent)).toBe(true);
    expect(await exists(withinRetention)).toBe(true);
    expect(await exists(path.join(withinRetention, ".tmp"))).toBe(false); // idle > grace: cache dropped, state kept
  });

  it("never touches a home with a live lease, however old, and reclaims a lease left by a dead process", async () => {
    const busy = await makeHome(1, 30 * DAY);
    const lease = await acquireCodexHomeLease(busy, "run-1", { ...resolveCodexHomeLifecycleOptions(), ...opts() });
    expect(lease).not.toBeNull();
    // acquire marks the home used "now"; lease presence alone must also protect it.
    await fs.rm(path.join(busy, LAST_USED_FILE));
    await setIdle(busy, 30 * DAY);
    const protectedReport = await prune(99);
    expect(protectedReport.skippedInUse).toBe(1);
    expect(await exists(path.join(busy, ".tmp/plugins"))).toBe(true);
    expect(await removeIdleCodexHomeTemp(busy, { ...resolveCodexHomeLifecycleOptions(), ...opts() })).toBe(false);

    // Abnormal exit: the process that held the lease is gone and never released it.
    const child = spawn(process.execPath, ["-e", "0"]);
    const deadPid = await new Promise<number>((resolve) => child.on("exit", () => resolve(child.pid!)));
    const [leaseFile] = await fs.readdir(path.join(busy, LEASE_DIR_NAME));
    await fs.writeFile(path.join(busy, LEASE_DIR_NAME, leaseFile!), JSON.stringify({ pid: deadPid, runId: "run-1", startedAt: clock }));
    expect(await inspectCodexHomeLeases(busy, { ...resolveCodexHomeLifecycleOptions(), ...opts() })).toBe("idle");
    expect(await exists(path.join(busy, LEASE_DIR_NAME, leaseFile!))).toBe(false);
    const after = await prune(99);
    expect(after.homesRemoved).toEqual([digest(1)]);
  });

  it("only the last lease holder may drop the plugin clone; concurrent holders keep it", async () => {
    const home = await makeHome(1, 0);
    const o = { ...resolveCodexHomeLifecycleOptions(), ...opts() };
    const a = await acquireCodexHomeLease(home, "run-a", o);
    const b = await acquireCodexHomeLease(home, "run-b", o);
    expect(await a!.release()).toBe(false);
    expect(await exists(path.join(home, ".tmp/plugins"))).toBe(true);
    expect(await b!.release()).toBe(true);
    expect(await removeIdleCodexHomeTemp(home, o)).toBe(true);
    expect(await exists(path.join(home, ".tmp"))).toBe(false);
    expect(await exists(path.join(home, "sessions/2026/11/10/rollout.jsonl"))).toBe(true);
  });

  it("is safe when passes overlap: no throw, each home removed once, no spurious failures", async () => {
    for (let n = 1; n <= 6; n += 1) await makeHome(n, 30 * DAY);
    const reports = await Promise.all([prune(99), prune(99), prune(99)]);
    // A pass may list a home another pass already renamed away; it then deletes that garbage too.
    const removed = new Set(reports.flatMap((r) => r.homesRemoved).map((name) => name.split(".")[0]));
    expect([...removed].sort()).toEqual([1, 2, 3, 4, 5, 6].map(digest));
    expect(reports.flatMap((r) => r.failures)).toEqual([]);
    expect(await fs.readdir(agentRoot)).toEqual([]);
  });

  it("bounds the work per pass and reports truncation", async () => {
    for (let n = 1; n <= 5; n += 1) await makeHome(n, 30 * DAY);
    const first = await prune(99, { maxOperationsPerPass: 2 });
    expect(first.homesRemoved).toHaveLength(2);
    expect(first.truncated).toBe(true);
    const rest = await prune(99, { maxOperationsPerPass: 10 });
    expect(rest.homesRemoved).toHaveLength(3);
    expect(rest.truncated).toBe(false);
  });

  it("treats a home too large to scan as active instead of guessing", async () => {
    const home = await makeHome(1, 30 * DAY);
    const report = await prune(99, { maxScanEntries: 3 });
    expect(report.homesRemoved).toEqual([]);
    expect(await exists(home)).toBe(true);
  });

  it("reports a removal failure without throwing and retries the leftover on the next pass", async () => {
    const home = await makeHome(1, 30 * DAY);
    await fs.chmod(agentRoot, 0o555); // rename out of the agent root is denied
    const failed = await prune(99);
    expect(failed.homesRemoved).toEqual([]);
    expect(failed.failures.length).toBeGreaterThan(0);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
    await fs.chmod(agentRoot, 0o755);
    // A crashed pass leaves a renamed leftover; the next pass finishes it.
    const leftover = `${home}.reaping-deadbeef`;
    await fs.rename(home, leftover);
    const retried = await prune(99);
    expect(retried.homesRemoved).toEqual([`${digest(1)}.reaping-deadbeef`]);
    expect(await exists(leftover)).toBe(false);
  });

  it("never follows symlinks or leaves the agent directory", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(path.join(outside, ".tmp"), { recursive: true });
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    await fs.writeFile(path.join(outside, ".tmp/also-keep.txt"), "keep");
    // 1. A digest-named symlink to an external directory.
    await fs.symlink(outside, path.join(agentRoot, digest(1)));
    // 2. An expired home whose skills/.tmp are symlinks to external directories.
    const home = await makeHome(2, 30 * DAY);
    await fs.rm(path.join(home, ".tmp"), { recursive: true });
    await fs.symlink(path.join(outside, ".tmp"), path.join(home, ".tmp"));
    await fs.symlink(outside, path.join(home, "skills"));
    await setIdle(home, 30 * DAY); // backdate the new links themselves (lutimes), not their targets
    // 3. The agent directory itself replaced by a symlink to another company's tree.
    const otherCompany = path.join(root, "other-company-skill-runtimes");
    await fs.mkdir(path.join(otherCompany, "agent-2", digest(9)), { recursive: true });
    await fs.rm(path.join(companyHomeRoot, "connector-runtimes"), { recursive: true, force: true });
    await fs.symlink(otherCompany, path.join(companyHomeRoot, "connector-runtimes"));

    const report = await prune(99);
    expect(report.homesRemoved).toEqual([digest(2)]);
    expect(await exists(path.join(outside, "keep.txt"))).toBe(true);
    expect(await exists(path.join(outside, ".tmp/also-keep.txt"))).toBe(true);
    expect(await exists(path.join(otherCompany, "agent-2", digest(9)))).toBe(true);
    expect((await fs.lstat(path.join(agentRoot, digest(1)))).isSymbolicLink()).toBe(true);
  });

  it("ignores unsafe agent ids, and entries that are not digests", async () => {
    await makeHome(1, 30 * DAY);
    await fs.mkdir(path.join(agentRoot, "notes"));
    await fs.mkdir(path.join(agentRoot, digest(10).toUpperCase()));
    const traversal = await pruneSupersededCodexHomes({ companyHomeRoot, agentId: "../agent-1", current: null }, opts());
    expect(traversal.scanned).toBe(0);
    const report = await prune(99);
    expect(report.homesRemoved).toEqual([digest(1)]);
    expect(await exists(path.join(agentRoot, "notes"))).toBe(true);
    expect(await exists(path.join(agentRoot, digest(10).toUpperCase()))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // RAI-2819: lease / delete interleavings. Each test pins one ordering with the
  // protocol's stage hooks and an injected sleep, so nothing depends on timing.
  // -------------------------------------------------------------------------
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const leaseFiles = async (home: string) =>
    (await fs.readdir(path.join(home, LEASE_DIR_NAME)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const lifecycle = (extra: Parameters<typeof acquireCodexHomeLease>[2] = {}) => ({ ...opts(), leasePollMs: 1, ...extra });

  it("a lease taken after the reaper judged `.tmp` idle makes the run wait, then use a home nothing deletes", async () => {
    const home = await makeHome(1, 2 * HOUR);
    const waiting = deferred();
    const reaperDone = deferred();
    let acquired: Awaited<ReturnType<typeof acquireCodexHomeLease>> | undefined;
    let settled = false;
    const pending: { p?: Promise<unknown> } = {};
    const report = await prune(99, {
      onStage: async (stage) => {
        if (stage !== "reap-selected") return;
        // The reaper holds the lock and has already seen "no lease": a run arrives now.
        pending.p = acquireCodexHomeLease(home, "late-run", lifecycle({
          sleep: async () => { waiting.resolve(); await reaperDone.promise; },
        })).then((lease) => { acquired = lease; settled = true; });
        await waiting.promise;
        expect(settled).toBe(false); // it must not proceed while the reaper may still delete
      },
    });
    reaperDone.resolve();
    await pending.p;
    expect(report.tempRemoved).toEqual([digest(1)]);
    expect(acquired).not.toBeNull();
    expect(await leaseFiles(home)).toHaveLength(1);
    // The run now owns the home: Codex re-creates the clone and no later pass may take it.
    await fs.mkdir(path.join(home, ".tmp/plugins"), { recursive: true });
    expect(await removeIdleCodexHomeTemp(home, opts())).toBe(false);
    expect((await prune(99)).tempRemoved).toEqual([]);
    expect(await exists(path.join(home, ".tmp/plugins"))).toBe(true);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it("the same interleaving on an expired home: the run gets a fresh home, never a half-deleted one", async () => {
    const home = await makeHome(1, 30 * DAY);
    const waiting = deferred();
    const reaperDone = deferred();
    let acquired: Awaited<ReturnType<typeof acquireCodexHomeLease>> | undefined;
    const pending: { p?: Promise<unknown> } = {};
    const report = await prune(99, {
      onStage: async (stage) => {
        if (stage !== "reap-selected") return;
        // The lease is written into the home right before the reaper renames it away.
        await fs.mkdir(path.join(home, LEASE_DIR_NAME), { recursive: true });
        await fs.writeFile(path.join(home, LEASE_DIR_NAME, "racing.json"), JSON.stringify({ pid: process.pid, runId: "racing", startedAt: clock }));
        pending.p = acquireCodexHomeLease(home, "late-run", lifecycle({
          sleep: async () => { waiting.resolve(); await reaperDone.promise; },
        })).then((lease) => { acquired = lease; });
        await waiting.promise;
      },
    });
    reaperDone.resolve();
    await pending.p;
    expect(report.homesRemoved).toEqual([digest(1)]);
    expect(acquired).not.toBeNull();
    // Fresh home: the old state is gone, the run's lease is intact, and the stranded
    // lease that was renamed away with the old home does not pin the new one.
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(false);
    expect(await leaseFiles(home)).toHaveLength(1);
    expect(await inspectCodexHomeLeases(home, opts())).toBe("busy");
    expect((await fs.readdir(agentRoot)).filter((n) => n.includes("reaping"))).toEqual([]);
    expect((await prune(99)).homesRemoved).toEqual([]);
  });

  it("a lease written before the reaper takes its lock is seen by the reaper, which leaves the home alone", async () => {
    const home = await makeHome(1, 30 * DAY);
    let inner: Awaited<ReturnType<typeof pruneSupersededCodexHomes>> | undefined;
    let tempRemoved: boolean | undefined;
    const lease = await acquireCodexHomeLease(home, "early-run", lifecycle({
      onStage: async (stage) => {
        if (stage !== "after-lease-write") return;
        // The run's lease is on disk but it has not re-checked the lock yet.
        tempRemoved = await removeIdleCodexHomeTemp(home, opts());
        inner = await prune(99);
      },
    }));
    expect(lease).not.toBeNull();
    expect(tempRemoved).toBe(false);
    expect(inner?.homesRemoved).toEqual([]);
    expect(inner?.skippedInUse).toBe(1);
    expect(await exists(path.join(home, ".tmp/plugins"))).toBe(true);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it("a reaper that finishes before the run writes its lease costs the run nothing but a fresh home", async () => {
    const home = await makeHome(1, 30 * DAY);
    let inner: Awaited<ReturnType<typeof pruneSupersededCodexHomes>> | undefined;
    const lease = await acquireCodexHomeLease(home, "run", lifecycle({
      onStage: async (stage) => {
        if (stage === "before-lease-write" && !inner) inner = await prune(99); // renames the old home away
      },
    }));
    expect(inner?.homesRemoved).toEqual([digest(1)]);
    expect(lease).not.toBeNull();
    expect(await leaseFiles(home)).toHaveLength(1);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(false);
    expect((await prune(99)).homesRemoved).toEqual([]); // the new home is leased
  });

  it("does not reap a home whose run started and finished after the unlocked idleness check", async () => {
    const home = await makeHome(1, 30 * DAY);
    const report = await prune(99, {
      onStage: async (stage, target) => {
        if (stage !== "reap-requested") return;
        // Between the unlocked "looks idle" check and the lock, a run uses the home and ends.
        const lease = await acquireCodexHomeLease(target, "quick-run", lifecycle());
        await fs.writeFile(path.join(target, "sessions/2026/11/10/rollout.jsonl"), "{\"new\":1}\n");
        await lease!.release();
      },
    });
    expect(report.homesRemoved).toEqual([]);
    expect(await fs.readFile(path.join(home, "sessions/2026/11/10/rollout.jsonl"), "utf8")).toBe("{\"new\":1}\n");
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it("a lease written while the reaper sits between its idle check and its rename is withdrawn, never lost", async () => {
    const home = await makeHome(1, 30 * DAY);
    const selected = deferred();
    const gate = deferred();
    let reaper: Promise<unknown> | undefined;
    let started = false;
    const lease = await acquireCodexHomeLease(home, "run", lifecycle({
      onStage: async (stage) => {
        if (stage !== "before-lease-write" || started) return;
        started = true;
        // The run passed its first lock check; now a reaper locks the home, sees no
        // lease, and pauses right before it renames the home away.
        reaper = prune(99, { onStage: async (s) => { if (s === "reap-selected") { selected.resolve(); await gate.promise; } } });
        await selected.promise;
      },
      // The run's retry has to wait for the reaper; only then does the reaper finish.
      sleep: async () => { gate.resolve(); await reaper; },
    }));
    gate.resolve();
    await reaper;
    expect(lease).not.toBeNull();
    // The lease must live in the home the run will use, not in garbage the reaper deleted.
    expect(await leaseFiles(home)).toHaveLength(1);
    expect(await inspectCodexHomeLeases(home, opts())).toBe("busy");
    expect((await fs.readdir(agentRoot)).filter((n) => n.includes("reaping"))).toEqual([]);
  });

  it("a reaper that runs the instant a lease is dropped still sees the run's use of the home", async () => {
    const home = await makeHome(1, 30 * DAY);
    let during: Awaited<ReturnType<typeof pruneSupersededCodexHomes>> | undefined;
    const lease = await acquireCodexHomeLease(home, "run", lifecycle({
      onStage: async (stage) => {
        if (stage === "lease-dropped") during = await prune(99); // no lease left, nothing else but last-used
      },
    }));
    await setIdle(home, 30 * DAY); // the run left no session writes; only its stamps say it was used
    expect(await lease!.release()).toBe(true);
    expect(during?.homesRemoved).toEqual([]);
    expect(during?.tempRemoved).toEqual([]);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it("release stamps last-used before dropping the lease, so a just-finished run's home is not reaped", async () => {
    const home = await makeHome(1, 30 * DAY);
    const lease = await acquireCodexHomeLease(home, "run", lifecycle());
    await fs.rm(path.join(home, LAST_USED_FILE), { force: true });
    await setIdle(home, 30 * DAY);
    expect(await lease!.release()).toBe(true);
    expect((await prune(99)).homesRemoved).toEqual([]);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it("never reclaims a live run's lease by age: beyond 48 hours it keeps home, sessions and plugins", async () => {
    const home = await makeHome(1, 30 * DAY);
    const lease = await acquireCodexHomeLease(home, "long-run", lifecycle({ retentionMs: DAY }));
    expect(lease).not.toBeNull();
    for (const elapsed of [49 * HOUR, 10 * DAY, 400 * DAY]) {
      clock += elapsed;
      expect(await inspectCodexHomeLeases(home, opts())).toBe("busy");
      expect(await removeIdleCodexHomeTemp(home, opts())).toBe(false);
      const report = await prune(99, { retentionMs: DAY, tempGraceMs: HOUR });
      expect(report.homesRemoved).toEqual([]);
      expect(report.tempRemoved).toEqual([]);
      expect(report.skippedInUse).toBe(1);
    }
    expect(await exists(path.join(home, ".tmp/plugins/marketplace.json"))).toBe(true);
    expect(await exists(path.join(home, "sessions/2026/11/10/rollout.jsonl"))).toBe(true);
    expect(await leaseFiles(home)).toHaveLength(1);
    // Only the death of its process (or its own release) ends the lease.
    expect(await inspectCodexHomeLeases(home, { ...opts(), isPidAlive: () => false })).toBe("idle");
  });

  it("an unreadable lease is trusted only for the grace period", async () => {
    const home = await makeHome(1, 30 * DAY);
    const dir = path.join(home, LEASE_DIR_NAME);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "corrupt.json"), "{not json");
    await fs.writeFile(path.join(dir, "half-written.json.partial"), "{");
    const o = { ...resolveCodexHomeLifecycleOptions(), ...opts() };
    expect(await inspectCodexHomeLeases(home, o)).toBe("busy");
    clock += 3 * DAY;
    expect(await inspectCodexHomeLeases(home, o)).toBe("idle");
    await fs.writeFile(path.join(dir, "live.json"), JSON.stringify({ pid: process.pid, runId: "r", startedAt: clock - HOUR }));
    expect(await inspectCodexHomeLeases(home, o)).toBe("busy");
  });

  it("returns no lease, and leaves nothing behind, when the lease cannot be written", async () => {
    const home = await makeHome(1, 30 * DAY);
    await fs.writeFile(path.join(home, LEASE_DIR_NAME), "not a directory");
    expect(await acquireCodexHomeLease(home, "run", lifecycle())).toBeNull();
    // A home whose lease state cannot be read is treated as in use, never as idle.
    expect(await inspectCodexHomeLeases(home, opts())).toBe("unknown");
    const report = await prune(99);
    expect(report.homesRemoved).toEqual([]);
    expect(report.skippedInUse).toBe(1);
    expect(await removeIdleCodexHomeTemp(home, opts())).toBe(false);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
    expect(await exists(path.join(home, ".tmp/plugins"))).toBe(true);
  });

  it("gives up (fail closed) when a live reaper never releases its lock, and clears a dead reaper's lock", async () => {
    const home = await makeHome(1, 30 * DAY);
    const lock = path.join(agentRoot, `${digest(1)}.reap-lock`);
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: clock, token: "t" }));
    expect(await acquireCodexHomeLease(home, "run", lifecycle({ leaseWaitMs: 5, sleep: async () => undefined }))).toBeNull();
    expect(await leaseFiles(home)).toEqual([]);
    // The reaper died holding the lock: the next run clears it and proceeds.
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: clock, token: "t" }));
    const lease = await acquireCodexHomeLease(home, "run", lifecycle({ isPidAlive: () => false }));
    expect(lease).not.toBeNull();
    expect(await exists(lock)).toBe(false);
    await lease!.release();
    // A reused PID is indistinguishable from the original live owner: fail closed.
    const record = JSON.stringify({ pid: process.pid, startedAt: clock - 400 * DAY, token: "old" });
    await fs.writeFile(lock, record);
    expect(await acquireCodexHomeLease(home, "run-3", lifecycle({ leaseWaitMs: 2, sleep: async () => undefined }))).toBeNull();
    expect(await fs.readFile(lock, "utf8")).toBe(record);
    expect((await prune(99)).homesRemoved).toEqual([]);
    expect(await removeIdleCodexHomeTemp(home, opts())).toBe(false);
  });

  it.each(["home", ".tmp"] as const)("keeps a live %s reaper exclusive after stillHeld while rename is suspended beyond the stale age", async (victim) => {
    const home = await makeHome(1, 30 * DAY);
    const target = victim === "home" ? home : path.join(home, ".tmp");
    const renameEntered = deferred();
    const resumeRename = deferred();
    const rename = fs.rename.bind(fs);
    // Pause the actual destructive rename, AFTER stillHeld has returned true.
    // All other renames (including the acquirer's .partial -> .json) remain real.
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === target && String(to).includes(".reaping-")) {
        renameEntered.resolve();
        await resumeRename.promise;
      }
      return rename(from, to);
    });
    const reaper = victim === "home" ? prune(99) : removeIdleCodexHomeTemp(home, opts());
    let competing: Awaited<ReturnType<typeof acquireCodexHomeLease>> = null;
    const marker = path.join(home, "active-marker");
    const pluginMarker = path.join(home, ".tmp/plugins/active-marker");
    try {
      await renameEntered.promise;
      clock += 6 * 60 * 1000;
      competing = await acquireCodexHomeLease(home, "competing", lifecycle({
        leaseWaitMs: 2, sleep: async () => undefined,
      }));
      // On the buggy source acquisition succeeds. Write real run resources before
      // letting the old reaper finish, so a false success proves actual data loss.
      if (competing) {
        await fs.writeFile(marker, "active");
        await fs.writeFile(pluginMarker, "active");
        await fs.writeFile(path.join(home, "sessions/2026/11/10/rollout.jsonl"), "active session\n");
      }
      resumeRename.resolve();
      const result = await reaper;
      if (competing) {
        expect(await exists(marker), "successful lease lost its home marker").toBe(true);
        expect(await exists(pluginMarker), "successful lease lost its plugin marker").toBe(true);
        expect(await fs.readFile(path.join(home, "sessions/2026/11/10/rollout.jsonl"), "utf8")).toBe("active session\n");
      }
      expect(competing, "a live reaper must retain exclusivity regardless of lock age").toBeNull();
      if (victim === "home") expect(result).toMatchObject({ homesRemoved: [digest(1)], failures: [] });
      else {
        expect(result).toBe(true);
        expect(await fs.readFile(path.join(home, "sessions/2026/11/10/rollout.jsonl"), "utf8")).toBe("{}\n");
      }
      // Once the owner releases normally, acquire can succeed and subsequent
      // reapers must preserve the new run's home, sessions and plugin resources.
      const next = await acquireCodexHomeLease(home, "after-reaper", lifecycle());
      expect(next).not.toBeNull();
      try {
        await fs.mkdir(path.join(home, ".tmp/plugins"), { recursive: true });
        await fs.mkdir(path.join(home, "sessions"), { recursive: true });
        await fs.writeFile(marker, "active");
        await fs.writeFile(pluginMarker, "active");
        await fs.writeFile(path.join(home, "sessions/active.jsonl"), "active session\n");
        expect(await removeIdleCodexHomeTemp(home, opts())).toBe(false);
        expect((await prune(99)).homesRemoved).toEqual([]);
        expect(await fs.readFile(marker, "utf8")).toBe("active");
        expect(await fs.readFile(pluginMarker, "utf8")).toBe("active");
        expect(await fs.readFile(path.join(home, "sessions/active.jsonl"), "utf8")).toBe("active session\n");
        expect(await leaseFiles(home)).toHaveLength(1);
      } finally { await next?.release(); }
    } finally {
      resumeRename.resolve();
      await reaper;
      await competing?.release();
      spy.mockRestore();
    }
  });

  it.each(["home", ".tmp"] as const)("preserves successful leases during concurrent dead-lock recovery of %s", async (victim) => {
    const home = await makeHome(1, 30 * DAY);
    const lock = `${home}.reap-lock`;
    const child = spawn(process.execPath, ["-e", "0"]);
    const deadPid = await new Promise<number>((resolve) => child.once("exit", () => resolve(child.pid!)));
    await fs.writeFile(lock, JSON.stringify({ pid: deadPid, startedAt: clock, token: "dead" }));
    const unlinkEntered = deferred();
    const resumeUnlink = deferred();
    const renameEntered = deferred();
    const resumeRename = deferred();
    const rm = fs.rm.bind(fs);
    const rename = fs.rename.bind(fs);
    let first = true;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === lock && first) {
        first = false;
        unlinkEntered.resolve();
        await resumeUnlink.promise;
      }
      return rm(file, options);
    });
    const target = victim === "home" ? home : path.join(home, ".tmp");
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === target && String(to).includes(".reaping-")) {
        renameEntered.resolve(); // the owner has already passed stillHeld
        await resumeRename.promise;
      }
      return rename(from, to);
    });
    const acquire = acquireCodexHomeLease(home, "delayed-recovery", lifecycle({ leaseWaitMs: 2, sleep: async () => undefined }));
    let reaper: Promise<unknown> | undefined;
    let lease: Awaited<typeof acquire> = null;
    try {
      await unlinkEntered.promise;
      reaper = victim === "home" ? prune(99) : removeIdleCodexHomeTemp(home, opts());
      // Old source reaches rename under a new live token; fixed source refuses
      // recovery while the first caller holds the guard. Neither path uses timers.
      const outcome = await Promise.race([
        renameEntered.promise.then(() => "renaming"),
        reaper.then(() => "refused"),
      ]);
      if (outcome === "renaming") {
        const record = JSON.parse(await fs.readFile(lock, "utf8"));
        expect(record.pid).toBe(process.pid);
        expect(record.token).not.toBe("dead");
      }
      resumeUnlink.resolve();
      lease = await acquire;
      // A safe null is allowed: QA's assert.ok(lease) is only a reproduction oracle.
      if (lease) {
        expect(await inspectCodexHomeLeases(home, opts())).toBe("busy");
        await fs.writeFile(path.join(home, ".tmp/plugins/active-marker"), "active plugin");
        await fs.writeFile(path.join(home, "sessions/active-marker"), "active session");
      }
      resumeRename.resolve();
      await reaper;
      if (lease) {
        expect(await exists(path.join(home, ".tmp/plugins/active-marker")), "successful lease lost its plugin").toBe(true);
        expect(await exists(path.join(home, "sessions/active-marker")), "successful lease lost its session").toBe(true);
        expect(await inspectCodexHomeLeases(home, opts())).toBe("busy");
        expect(await removeIdleCodexHomeTemp(home, opts())).toBe(false);
        expect((await prune(99)).homesRemoved).toEqual([]);
      }
      if (outcome === "refused") {
        // Even when acquire safely returns null, the refused reaper must retain
        // the existing resources; do not let a null lease make this vacuous.
        expect(await exists(path.join(home, ".tmp/plugins/marketplace.json"))).toBe(true);
        expect(await exists(path.join(home, "sessions/2026/11/10/rollout.jsonl"))).toBe(true);
      }
      expect(outcome, "concurrent dead-lock recovery must exclude a second unlink").toBe("refused");
    } finally {
      resumeUnlink.resolve();
      resumeRename.resolve();
      await Promise.allSettled([acquire, reaper]);
      await lease?.release();
      rmSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it.each(["home", ".tmp"] as const)("revalidates a stale dead-owner observation while a new %s reaper is suspended after stillHeld", async (victim) => {
    const home = await makeHome(1, 30 * DAY);
    const lock = `${home}.reap-lock`;
    const child = spawn(process.execPath, ["-e", "0"]);
    const deadPid = await new Promise<number>((resolve) => child.once("exit", () => resolve(child.pid!)));
    await fs.writeFile(lock, JSON.stringify({ pid: deadPid, startedAt: clock, token: "dead" }));
    const readEntered = deferred();
    const resumeRead = deferred();
    const renameEntered = deferred();
    const resumeRename = deferred();
    const readFile = fs.readFile.bind(fs);
    const rename = fs.rename.bind(fs);
    let first = true;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (file, ...args) => {
      const contents = await readFile(file, ...args);
      if (file === lock && first) {
        first = false;
        readEntered.resolve();
        await resumeRead.promise;
      }
      return contents;
    });
    const target = victim === "home" ? home : path.join(home, ".tmp");
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === target && String(to).includes(".reaping-")) {
        renameEntered.resolve();
        await resumeRename.promise;
      }
      return rename(from, to);
    });
    const acquire = acquireCodexHomeLease(home, "stale-reader", lifecycle({ leaseWaitMs: 2, sleep: async () => undefined }));
    let reaper: Promise<unknown> | undefined;
    let lease: Awaited<typeof acquire> = null;
    try {
      await readEntered.promise;
      reaper = victim === "home" ? prune(99) : removeIdleCodexHomeTemp(home, opts());
      await renameEntered.promise;
      const liveRecord = await readFile(lock, "utf8");
      expect(JSON.parse(liveRecord).pid).toBe(process.pid);
      resumeRead.resolve();
      lease = await acquire;
      if (lease) {
        await fs.writeFile(path.join(home, ".tmp/plugins/active-marker"), "active plugin");
        await fs.writeFile(path.join(home, "sessions/active-marker"), "active session");
      }
      resumeRename.resolve();
      await reaper;
      if (lease) {
        expect(await exists(path.join(home, ".tmp/plugins/active-marker")), "successful lease lost its plugin").toBe(true);
        expect(await exists(path.join(home, "sessions/active-marker")), "successful lease lost its session").toBe(true);
      }
      expect(lease, "stale observation must not remove the new live lock").toBeNull();
    } finally {
      resumeRead.resolve();
      resumeRename.resolve();
      await Promise.allSettled([acquire, reaper]);
      await lease?.release();
      readSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it.each([
    "{", "null", "{}",
    JSON.stringify({ pid: 0, startedAt: 0, token: "t" }),
    JSON.stringify({ pid: -1, startedAt: 0, token: "t" }),
    JSON.stringify({ pid: 1.5, startedAt: 0, token: "t" }),
    JSON.stringify({ pid: "123", startedAt: 0, token: "t" }),
  ])("fails closed for an old damaged reap lock: %s", async (contents) => {
    const home = await makeHome(1, 30 * DAY);
    const lock = `${home}.reap-lock`;
    await fs.writeFile(lock, contents);
    await fs.utimes(lock, new Date(clock - DAY), new Date(clock - DAY));
    clock += 400 * DAY;
    const probe = vi.fn(() => false);
    expect(await acquireCodexHomeLease(home, "run", lifecycle({
      leaseWaitMs: 2, sleep: async () => undefined, isPidAlive: probe,
    }))).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(await fs.readFile(lock, "utf8")).toBe(contents);
    expect((await prune(99)).homesRemoved).toEqual([]);
    expect(await removeIdleCodexHomeTemp(home, opts())).toBe(false);
    expect(await exists(path.join(home, ".tmp/plugins/marketplace.json"))).toBe(true);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it.each(["abandoned guard", "guard I/O", "unlink I/O", "guarded read I/O"] as const)("fails closed on dead-lock recovery with %s", async (failure) => {
    const home = await makeHome(1, 30 * DAY);
    const lock = `${home}.reap-lock`;
    const guard = `${lock}.recovery`;
    const record = JSON.stringify({ pid: 123456, startedAt: clock, token: "dead" });
    await fs.writeFile(lock, record);
    if (failure === "abandoned guard") await fs.mkdir(guard);
    const mkdir = fs.mkdir.bind(fs);
    const rm = fs.rm.bind(fs);
    const readFile = fs.readFile.bind(fs);
    const denied = Object.assign(new Error("injected recovery I/O failure"), { code: "EACCES" });
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (file, ...args) => {
      if (file === guard && failure === "guard I/O") throw denied;
      return mkdir(file, ...args);
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === lock && failure === "unlink I/O") throw denied;
      return rm(file, options);
    });
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (file, ...args) => {
      if (file === lock && failure === "guarded read I/O" && await exists(guard)) throw denied;
      return readFile(file, ...args);
    });
    const options = lifecycle({ leaseWaitMs: 2, sleep: async () => undefined, isPidAlive: () => false });
    try {
      expect(await acquireCodexHomeLease(home, "run", options)).toBeNull();
      expect(await removeIdleCodexHomeTemp(home, options)).toBe(false);
      expect((await prune(99, options)).homesRemoved).toEqual([]);
      expect(await readFile(lock, "utf8")).toBe(record);
      expect(await exists(path.join(home, ".tmp/plugins/marketplace.json"))).toBe(true);
      expect(await exists(path.join(home, "sessions/2026/11/10/rollout.jsonl"))).toBe(true);
      expect(await exists(guard)).toBe(failure === "abandoned guard");
    } finally {
      mkdirSpy.mockRestore();
      rmSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it("refuses acquisition when the lock cannot be inspected after a guarded unlink", async () => {
    const home = await makeHome(1, 30 * DAY);
    const lock = `${home}.reap-lock`;
    await fs.writeFile(lock, JSON.stringify({ pid: 123456, startedAt: clock, token: "dead" }));
    const lstat = fs.lstat.bind(fs);
    const rm = fs.rm.bind(fs);
    let removed = false;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      await rm(file, options);
      if (file === lock) removed = true;
    });
    const statSpy = vi.spyOn(fs, "lstat").mockImplementation(async (file, ...args) => {
      if (file === lock && removed) throw Object.assign(new Error("injected lock stat failure"), { code: "EACCES" });
      return lstat(file, ...args);
    });
    try {
      expect(await acquireCodexHomeLease(home, "run", lifecycle({
        leaseWaitMs: 2, sleep: async () => undefined, isPidAlive: () => false,
      }))).toBeNull();
      expect(removed).toBe(true);
      expect(await exists(`${lock}.recovery`)).toBe(false);
      expect(await exists(path.join(home, ".tmp/plugins/marketplace.json"))).toBe(true);
      expect(await exists(path.join(home, "sessions/2026/11/10/rollout.jsonl"))).toBe(true);
    } finally { rmSpy.mockRestore(); statSpy.mockRestore(); }
  });

  it("recovers a real dead reaper's lock for both destructive entry points", async () => {
    const child = spawn(process.execPath, ["-e", "0"]);
    const deadPid = await new Promise<number>((resolve) => child.on("exit", () => resolve(child.pid!)));
    for (const victim of ["home", ".tmp"]) {
      const home = await makeHome(victim === "home" ? 1 : 2, 30 * DAY);
      await fs.writeFile(`${home}.reap-lock`, JSON.stringify({ pid: deadPid, startedAt: clock, token: "dead" }));
      if (victim === "home") expect((await prune(99)).homesRemoved).toEqual([digest(1)]);
      else {
        expect(await removeIdleCodexHomeTemp(home, opts())).toBe(true);
        expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
      }
      expect(await exists(`${home}.reap-lock`)).toBe(false);
    }
  });

  it.each(["write", "partial rename"])("returns no lease and removes partial files after a lease %s failure", async (failure) => {
    const home = await makeHome(1, 30 * DAY);
    const writeFile = fs.writeFile.bind(fs);
    const rename = fs.rename.bind(fs);
    const denied = Object.assign(new Error("injected lease I/O failure"), { code: "EACCES" });
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
      await writeFile(file, ...args);
      if (failure === "write" && String(file).endsWith(".json.partial")) throw denied;
    });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (failure === "partial rename" && String(from).endsWith(".json.partial")) throw denied;
      return rename(from, to);
    });
    try {
      expect(await acquireCodexHomeLease(home, "run", lifecycle())).toBeNull();
      expect(await fs.readdir(path.join(home, LEASE_DIR_NAME))).toEqual([]);
      expect(await inspectCodexHomeLeases(home, opts())).toBe("idle");
      expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
      expect(await exists(path.join(home, ".tmp/plugins/marketplace.json"))).toBe(true);
    } finally { writeSpy.mockRestore(); renameSpy.mockRestore(); }
    // A transient failure must not strand the home: the next acquisition works.
    const recovered = await acquireCodexHomeLease(home, "retry", lifecycle());
    expect(recovered).not.toBeNull();
    await recovered?.release();
  });

  it("sweeps a `.tmp.reaping-*` leftover and never counts it as session activity", async () => {
    const home = await makeHome(1, 2 * HOUR);
    await fs.rename(path.join(home, ".tmp"), path.join(home, ".tmp.reaping-deadbeef"));
    const report = await prune(99);
    expect(report.tempRemoved).toEqual([digest(1)]);
    expect(await exists(path.join(home, ".tmp.reaping-deadbeef"))).toBe(false);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it("invariant under real concurrency: a run that holds a lease never loses its marker", async () => {
    const home = await makeHome(1, 30 * DAY);
    const violations: string[] = [];
    let stop = false;
    const reaper = (async () => {
      while (!stop) {
        await prune(99);
        await removeIdleCodexHomeTemp(home, opts());
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const runner = async (id: number) => {
      for (let i = 0; i < 25; i += 1) {
        // Backdate before every run so each iteration is a fresh chance to be reaped.
        const lease = await acquireCodexHomeLease(home, `run-${id}-${i}`, lifecycle({ leaseWaitMs: 10_000 }));
        if (!lease) { violations.push(`run-${id}-${i}: no lease`); continue; }
        const marker = path.join(home, `marker-${id}-${i}`);
        await fs.writeFile(marker, "x");
        await fs.mkdir(path.join(home, ".tmp/plugins"), { recursive: true });
        await new Promise((resolve) => setImmediate(resolve));
        if (!(await exists(marker))) violations.push(`run-${id}-${i}: home deleted under a live lease`);
        if (!(await exists(path.join(home, ".tmp/plugins")))) violations.push(`run-${id}-${i}: plugins deleted under a live lease`);
        await lease.release();
        await fs.rm(marker, { force: true });
        await setIdle(home, 30 * DAY).catch(() => undefined);
      }
    };
    await Promise.all([runner(1), runner(2), runner(3)]);
    stop = true;
    await reaper;
    expect(violations).toEqual([]);
  }, 60_000);
});
