import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("keeps a lease from a live process, a corrupt lease, and only trusts them until the backstop age", async () => {
    const home = await makeHome(1, 30 * DAY);
    const dir = path.join(home, LEASE_DIR_NAME);
    await fs.mkdir(dir);
    const o = { ...resolveCodexHomeLifecycleOptions(), ...opts() };
    await fs.writeFile(path.join(dir, "corrupt.json"), "{not json");
    expect(await inspectCodexHomeLeases(home, o)).toBe("busy");
    clock += 3 * DAY; // past maxLeaseMs (2d): a never-released lease must not pin a home forever
    expect(await inspectCodexHomeLeases(home, o)).toBe("idle");
    await fs.writeFile(path.join(dir, "old-live.json"), JSON.stringify({ pid: process.pid, runId: "r", startedAt: clock - 3 * DAY }));
    expect(await inspectCodexHomeLeases(home, o)).toBe("idle");
    await fs.writeFile(path.join(dir, "live.json"), JSON.stringify({ pid: process.pid, runId: "r", startedAt: clock - HOUR }));
    expect(await inspectCodexHomeLeases(home, o)).toBe("busy");
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

  it("restores a home that a run leased between the idle check and the delete", async () => {
    const home = await makeHome(1, 30 * DAY);
    const report = await prune(99, {
      afterRename: async (renamed) => {
        const lease = path.join(renamed, LEASE_DIR_NAME);
        await fs.mkdir(lease, { recursive: true });
        await fs.writeFile(path.join(lease, "late.json"), JSON.stringify({ pid: process.pid, runId: "late", startedAt: clock }));
      },
    });
    expect(report.homesRemoved).toEqual([]);
    expect(report.skippedInUse).toBe(1);
    expect(await exists(path.join(home, "state_5.sqlite"))).toBe(true);
  });

  it("is safe when passes overlap: no throw, each home removed once, no spurious failures", async () => {
    for (let n = 1; n <= 6; n += 1) await makeHome(n, 30 * DAY);
    const reports = await Promise.all([prune(99), prune(99), prune(99)]);
    expect(reports.flatMap((r) => r.homesRemoved).sort()).toEqual([1, 2, 3, 4, 5, 6].map(digest));
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
});
