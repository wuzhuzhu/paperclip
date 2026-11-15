import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Lifecycle of generated Codex homes (`<company>/codex-home/{skill,connector}-runtimes/<agent>/<digest>`).
 *
 * A home is "in use" only while a run lease exists inside it. Directory mtimes
 * are never used as a liveness signal: sqlite WAL/session writes do not bump
 * the top-level directory, and a long-running run touches nothing at the top.
 *
 * Retention basis (RAI-2802): a generated home is only a resume target while its
 * digest recurs, and the digest changes only when the agent's skills, connector
 * grants, selected config, or connected account change. Seven days of inactivity
 * keeps a home through a week-long rollback of such a change (one weekly
 * release/ops cycle) while still bounding disk. Disposable `.tmp` (the Codex
 * plugin marketplace clone and its sync lock) is dropped after an hour idle
 * because Codex re-syncs it on demand. Both are env-tunable.
 *
 * Concurrency protocol (RAI-2819). A run's lease and a reaper's delete must never
 * interleave so that a live run loses its home. Both sides use a Dekker-style
 * handshake around a per-home reap lock that lives OUTSIDE the home
 * (`<home>.reap-lock`, so deleting the home cannot delete the lock):
 *
 *   reaper:   take lock -> inspect leases (must be idle) -> re-check idleness
 *             -> atomically rename the victim away -> drop lock -> delete garbage
 *   acquirer: wait for no lock -> write lease -> re-check lock; if a reaper holds
 *             it, withdraw the lease and retry; finally verify the lease file is
 *             still where it was written
 *
 * Either the reaper's inspect sees the lease (it backs off), or the acquirer's
 * re-check sees the lock (it backs off). Deletion is a rename, so a run that
 * wins the lease never sees a half-deleted home: it starts on the original home
 * or, if a reaper took it first, on a freshly created one. A lease whose process
 * is alive is never reclaimed, however old: there is no age backstop for it.
 * The same holds for reap locks: elapsed time cannot fence a paused owner that
 * already passed stillHeld and may resume its rename. Only a valid PID proven
 * dead permits recovery. Damaged locks and reused live PIDs fail closed; without
 * process-start identity, PID reuse cannot safely be distinguished from liveness.
 */
export const GENERATED_HOME_KINDS = ["skill-runtimes", "connector-runtimes"] as const;
export type GeneratedHomeKind = (typeof GENERATED_HOME_KINDS)[number];

export const LEASE_DIR_NAME = ".paperclip-leases";
export const LAST_USED_FILE = ".paperclip-last-used";
const REAP_LOCK_SUFFIX = ".reap-lock";
const TEMP_DIR = ".tmp";
const MAX_LEASE_ATTEMPTS = 50;
const TEMP_REAPING = /^\.tmp\.reaping-[a-f0-9]{8}$/;
const DIGEST_DIR = /^[a-f0-9]{64}$/;
const REAPING_DIR = /^[a-f0-9]{64}\.reaping-[a-f0-9]{8}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CodexHomeLifecycleStage =
  /** Acquirer: lock was clear; the lease is about to be written. */
  | "before-lease-write"
  /** Acquirer: lease is on disk; the reap lock is about to be re-checked. */
  | "after-lease-write"
  /** Run end: the lease file is gone; nothing else protects the home any more. */
  | "lease-dropped"
  /** Reaper: about to take the lock (after the unlocked idleness check). */
  | "reap-requested"
  /** Reaper: lock held and home judged idle; the rename is about to happen. */
  | "reap-selected"
  /** Reaper: victim renamed away and lock dropped; garbage is about to be deleted. */
  | "reap-renamed";

export interface CodexHomeLifecycleOptions {
  retentionMs: number;
  tempGraceMs: number;
  /**
   * A lease file that cannot be parsed has no pid to probe. It is trusted only for
   * this long. A parsed lease whose process is alive is NEVER reclaimed by age.
   */
  unreadableLeaseGraceMs: number;
  /** @deprecated Retained for caller compatibility; lock age never permits takeover. */
  reapLockStaleMs: number;
  /** How long a run waits for a reaper to finish its (millisecond-scale) critical section. */
  leaseWaitMs: number;
  leasePollMs: number;
  /** Total removals (temp dirs + whole homes) per pass; keeps a run's tail latency bounded. */
  maxOperationsPerPass: number;
  /** Entries inspected per home when looking for recent activity; past it the home counts as active. */
  maxScanEntries: number;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Test seam: deterministic interleaving points of the lease/reap protocol. */
  onStage?: (stage: CodexHomeLifecycleStage, target: string) => Promise<void>;
}

function positiveNumber(value: string | undefined): number | null {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function resolveCodexHomeLifecycleOptions(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CodexHomeLifecycleOptions> = {},
): CodexHomeLifecycleOptions {
  return {
    retentionMs: (positiveNumber(env.PAPERCLIP_CODEX_HOME_RETENTION_DAYS) ?? 7) * DAY_MS,
    tempGraceMs: (positiveNumber(env.PAPERCLIP_CODEX_HOME_TEMP_GRACE_MINUTES) ?? 60) * 60 * 1000,
    unreadableLeaseGraceMs: 2 * DAY_MS,
    reapLockStaleMs: 5 * 60 * 1000,
    leaseWaitMs: 30_000,
    leasePollMs: 25,
    maxOperationsPerPass: 25,
    maxScanEntries: 20_000,
    now: Date.now,
    isPidAlive: defaultIsPidAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

/** Deleting the plugin clone at run end is on by default; set to keep it between runs. */
export function shouldDropPluginCloneAfterRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_CODEX_KEEP_PLUGIN_CACHE !== "1" && env.PAPERCLIP_CODEX_KEEP_PLUGIN_CACHE !== "true";
}


const errCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

// ---------------------------------------------------------------------------
// Reap lock (outside the home, see the protocol in the header comment)
// ---------------------------------------------------------------------------

interface ReapLockRecord { pid: number; startedAt: number; token: string }

export function reapLockPath(home: string): string {
  return `${home}${REAP_LOCK_SUFFIX}`;
}

/** "free" | "held" (a live reaper is inside its critical section). Abandoned locks are cleared. */
async function reapLockState(home: string, options: CodexHomeLifecycleOptions): Promise<"free" | "held"> {
  const file = reapLockPath(home);
  try {
    await fs.lstat(file);
  } catch (error) {
    return errCode(error) === "ENOENT" ? "free" : "held"; // cannot tell: fail closed
  }
  let record: Partial<ReapLockRecord> | null = null;
  try {
    record = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ReapLockRecord>;
  } catch { /* being written, or corrupt */ }
  const pid = record?.pid;
  // Age is not fencing: a live owner may be suspended inside fs.rename, after
  // its last ownership check. Invalid/unknown owners must also fail closed.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || options.isPidAlive(pid)) return "held";
  await fs.rm(file, { force: true }).catch(() => undefined);
  return (await exists(file)) ? "held" : "free";
}

async function waitForNoReapLock(home: string, options: CodexHomeLifecycleOptions): Promise<boolean> {
  const polls = Math.max(1, Math.ceil(options.leaseWaitMs / Math.max(1, options.leasePollMs)));
  for (let i = 0; i < polls; i += 1) {
    if ((await reapLockState(home, options)) === "free") return true;
    await options.sleep(options.leasePollMs);
  }
  return (await reapLockState(home, options)) === "free";
}

interface ReapLock { stillHeld(): Promise<boolean>; release(): Promise<void> }

async function takeReapLock(home: string, options: CodexHomeLifecycleOptions): Promise<ReapLock | null> {
  const file = reapLockPath(home);
  const token = randomBytes(8).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, "wx");
      try {
        const record: ReapLockRecord = { pid: process.pid, startedAt: options.now(), token };
        await handle.writeFile(JSON.stringify(record));
      } finally {
        await handle.close();
      }
      return {
        stillHeld: async () => {
          try {
            return (JSON.parse(await fs.readFile(file, "utf8")) as Partial<ReapLockRecord>).token === token;
          } catch { return false; }
        },
        release: async () => {
          try {
            if ((JSON.parse(await fs.readFile(file, "utf8")) as Partial<ReapLockRecord>).token === token) await fs.rm(file, { force: true });
          } catch { /* already gone or taken over */ }
        },
      };
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error; // not contention (e.g. EACCES): report it, do not hide it
      if ((await reapLockState(home, options)) === "held") return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export interface CodexHomeLease {
  home: string;
  /** Releases this run's lease. Returns true when no other live lease remains in the home. */
  release(): Promise<boolean>;
}

interface LeaseRecord { pid: number; runId: string; startedAt: number }

export async function touchCodexHomeLastUsed(home: string, now: () => number = Date.now): Promise<void> {
  await fs.writeFile(path.join(home, LAST_USED_FILE), new Date(now()).toISOString()).catch(() => undefined);
}

/**
 * Registers a run in the home and returns the lease, or null when it cannot be
 * established safely (lock wait timed out, lease unwritable). A run MUST NOT use
 * the home without a lease: reapers only honour leases.
 */
export async function acquireCodexHomeLease(
  home: string,
  runId: string,
  partial: Partial<CodexHomeLifecycleOptions> = {},
): Promise<CodexHomeLease | null> {
  const options = resolveCodexHomeLifecycleOptions(process.env, partial);
  const dir = path.join(home, LEASE_DIR_NAME);
  const name = `${runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "run"}-${randomBytes(4).toString("hex")}.json`;
  const file = path.join(dir, name);
  const partialFile = `${file}.partial`;
  // Each lost round means a reaper held the lock at that instant; its critical section is
  // milliseconds long, so a run only gives up after many rounds (or the wait budget).
  for (let attempt = 0; attempt < MAX_LEASE_ATTEMPTS; attempt += 1) {
    if (!(await waitForNoReapLock(home, options))) return null;
    await options.onStage?.("before-lease-write", home);
    try {
      await fs.mkdir(dir, { recursive: true });
      const record: LeaseRecord = { pid: process.pid, runId, startedAt: options.now() };
      // Written under a name the lease scan ignores, then renamed: a lease is never half-visible.
      await fs.writeFile(partialFile, JSON.stringify(record));
      await fs.rename(partialFile, file);
    } catch (error) {
      await fs.rm(partialFile, { force: true }).catch(() => undefined);
      await fs.rm(file, { force: true }).catch(() => undefined);
      if (errCode(error) === "ENOENT") continue; // the home was renamed away underneath us: start over on a fresh one
      return null;
    }
    await options.onStage?.("after-lease-write", home);
    // A reaper that took the lock before our lease existed may already have judged the
    // home idle. It cannot be allowed to delete a home we are about to use.
    if ((await reapLockState(home, options)) === "held") {
      await fs.rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    // The home may have been removed between the write and the lock check.
    if (!(await exists(file))) continue;
    await touchCodexHomeLastUsed(home, options.now);
    return {
      home,
      release: async () => {
        // Record the use first: a reaper that sees no lease must see a fresh last-used stamp.
        await touchCodexHomeLastUsed(home, options.now);
        await fs.rm(file, { force: true }).catch(() => undefined);
        await options.onStage?.("lease-dropped", home);
        return (await inspectCodexHomeLeases(home, options)) === "idle";
      },
    };
  }
  return null;
}

/**
 * "idle": provably no live run. "busy": a live lease exists. "unknown": the lease
 * state could not be read; destructive callers must treat it like "busy".
 * A lease is live while its process is alive, however long it has been running.
 */
export async function inspectCodexHomeLeases(
  home: string,
  partial: Partial<CodexHomeLifecycleOptions> = {},
): Promise<"idle" | "busy" | "unknown"> {
  const options = resolveCodexHomeLifecycleOptions(process.env, partial);
  const dir = path.join(home, LEASE_DIR_NAME);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    return errCode(error) === "ENOENT" ? "idle" : "unknown";
  }
  let state: "idle" | "busy" | "unknown" = "idle";
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // `.partial` files are not leases yet
    const file = path.join(dir, name);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (errCode(error) === "ENOENT") continue;
      state = "unknown";
      continue;
    }
    let record: LeaseRecord | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<LeaseRecord>;
      if (typeof parsed.pid === "number") record = parsed as LeaseRecord;
    } catch { /* corrupt */ }
    const live = record
      ? options.isPidAlive(record.pid)
      : options.now() - stat.mtimeMs <= options.unreadableLeaseGraceMs;
    if (live) return "busy";
    // Left by a crashed/killed process: reclaim the file.
    await fs.rm(file, { force: true }).catch(() => { state = "unknown"; });
  }
  return state;
}

// ---------------------------------------------------------------------------
// Reaping: one critical section for both `.tmp` and whole-home removal
// ---------------------------------------------------------------------------

type ReapAction = "none" | "temp" | "home";
type ReapOutcome = "locked-out" | "in-use" | "none" | "temp" | "home";

/**
 * Under the home's reap lock: re-inspect leases, let `decide` re-judge idleness
 * (so nothing stale from before the lock is trusted), then move the victim out of
 * the way with one rename. Returns what to delete once the lock is dropped.
 */
async function reapUnderLock(
  home: string,
  options: CodexHomeLifecycleOptions,
  decide: () => Promise<ReapAction>,
): Promise<{ outcome: ReapOutcome; garbage: string | null }> {
  await options.onStage?.("reap-requested", home);
  const lock = await takeReapLock(home, options);
  if (!lock) return { outcome: "locked-out", garbage: null };
  let garbage: string | null = null;
  let outcome: ReapOutcome = "none";
  try {
    if ((await inspectCodexHomeLeases(home, options)) !== "idle") return { outcome: "in-use", garbage: null };
    const action = await decide();
    if (action === "none") return { outcome: "none", garbage: null };
    await options.onStage?.("reap-selected", home);
    if (!(await lock.stillHeld())) return { outcome: "locked-out", garbage: null };
    const suffix = randomBytes(4).toString("hex");
    if (action === "home") {
      garbage = `${home}.reaping-${suffix}`;
      await fs.rename(home, garbage);
    } else {
      const target = path.join(home, TEMP_DIR);
      if (await exists(target)) {
        garbage = path.join(home, `${TEMP_DIR}.reaping-${suffix}`);
        await fs.rename(target, garbage);
      }
    }
    outcome = action;
  } catch (error) {
    garbage = null;
    if (errCode(error) !== "ENOENT") throw error;
    outcome = "none"; // already moved or removed by someone else
  } finally {
    await lock.release();
  }
  if (garbage) await options.onStage?.("reap-renamed", home);
  return { outcome, garbage };
}

async function listTempLeftovers(home: string): Promise<string[]> {
  const names = await fs.readdir(home).catch(() => [] as string[]);
  return names.filter((name) => TEMP_REAPING.test(name)).map((name) => path.join(home, name));
}

/**
 * Removes the Codex plugin marketplace clone (`.tmp`) from a home no run is using.
 * Codex re-creates it on demand; sessions, sqlite state and config are untouched.
 * The check and the removal are one critical section against run leases.
 */
export async function removeIdleCodexHomeTemp(
  home: string,
  partial: Partial<CodexHomeLifecycleOptions> = {},
): Promise<boolean> {
  const options = resolveCodexHomeLifecycleOptions(process.env, partial);
  const { outcome, garbage } = await reapUnderLock(home, options, async () =>
    (await exists(path.join(home, TEMP_DIR))) ? "temp" : "none");
  // rm never follows a symlink: a `.tmp` link is removed as a link, not its target.
  if (garbage) await fs.rm(garbage, { recursive: true, force: true });
  for (const leftover of await listTempLeftovers(home)) await fs.rm(leftover, { recursive: true, force: true });
  return outcome === "temp";
}

// ---------------------------------------------------------------------------
// Bounded recycling of superseded homes
// ---------------------------------------------------------------------------

export interface CodexHomePruneReport {
  scanned: number;
  tempRemoved: string[];
  homesRemoved: string[];
  skippedInUse: number;
  failures: Array<{ home: string; step: string; message: string }>;
  truncated: boolean;
}

/** Newest mtime of anything that proves the home was used. Infinity = could not tell (treat as active). */
async function newestActivityMs(home: string, stopAtOrAbove: number, maxEntries: number): Promise<number> {
  let newest = 0;
  let inspected = 0;
  const consider = async (target: string): Promise<boolean> => {
    inspected += 1;
    const stat = await fs.lstat(target).catch(() => null);
    if (stat) newest = Math.max(newest, stat.mtimeMs);
    return newest >= stopAtOrAbove;
  };
  if (await consider(path.join(home, LAST_USED_FILE))) return newest;
  const stack = [home];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errCode(error) === "ENOENT") continue;
      return Infinity;
    }
    for (const entry of entries) {
      // Disposable cache and our own bookkeeping say nothing about session use.
      if (dir === home && (entry.name === TEMP_DIR || TEMP_REAPING.test(entry.name) || entry.name === LEASE_DIR_NAME || entry.name === LAST_USED_FILE)) continue;
      if (inspected >= maxEntries) return Infinity;
      const full = path.join(dir, entry.name);
      if (await consider(full)) return newest;
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full);
    }
  }
  return newest;
}

async function within(parentReal: string, child: string): Promise<string | null> {
  const childReal = await fs.realpath(child).catch(() => null);
  if (!childReal) return null;
  return path.dirname(childReal) === parentReal ? childReal : null;
}

export interface PruneAgentHomesInput {
  /** `<managed>/companies/<company>/codex-home` */
  companyHomeRoot: string;
  agentId: string;
  /** The home the current run uses; never touched. */
  current: { kind: GeneratedHomeKind; digest: string } | null;
}

export async function pruneSupersededCodexHomes(
  input: PruneAgentHomesInput,
  partial: Partial<CodexHomeLifecycleOptions> = {},
): Promise<CodexHomePruneReport> {
  const options = resolveCodexHomeLifecycleOptions(process.env, partial);
  const report: CodexHomePruneReport = { scanned: 0, tempRemoved: [], homesRemoved: [], skippedInUse: 0, failures: [], truncated: false };
  const fail = (home: string, step: string, error: unknown) =>
    report.failures.push({ home, step, message: error instanceof Error ? error.message : String(error) });
  if (!SAFE_SEGMENT.test(input.agentId)) return report;
  const companyRoot = await fs.realpath(input.companyHomeRoot).catch(() => null);
  if (!companyRoot) return report;
  let budget = options.maxOperationsPerPass;

  for (const kind of GENERATED_HOME_KINDS) {
    const kindRoot = await within(companyRoot, path.join(companyRoot, kind));
    if (!kindRoot) continue;
    const agentRoot = await within(kindRoot, path.join(kindRoot, input.agentId));
    if (!agentRoot) continue;
    let names: string[];
    try {
      names = await fs.readdir(agentRoot);
    } catch (error) {
      fail(agentRoot, "list", error);
      continue;
    }
    for (const name of names) {
      if (budget <= 0) { report.truncated = true; break; }
      const full = path.join(agentRoot, name);
      if (REAPING_DIR.test(name)) {
        // Garbage by construction: it only exists after a reaper renamed an idle home
        // away under the reap lock. A pass that died before deleting it leaves it here.
        budget -= 1;
        await fs.rm(full, { recursive: true, force: true }).then(
          () => report.homesRemoved.push(name),
          (error) => fail(full, "remove-leftover", error),
        );
        continue;
      }
      if (!DIGEST_DIR.test(name)) continue;
      if (input.current?.kind === kind && input.current.digest === name) continue;
      const stat = await fs.lstat(full).catch(() => null);
      // Symlinked or non-directory entries are never followed or removed.
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      if ((await within(agentRoot, full)) === null) continue;
      report.scanned += 1;

      // Idleness is judged again inside the reap lock; this unlocked pass only avoids
      // taking the lock for homes that are plainly in use.
      const decide = async (): Promise<ReapAction> => {
        const now = options.now();
        const newest = await newestActivityMs(full, now - options.tempGraceMs, options.maxScanEntries);
        if (newest >= now - options.tempGraceMs) return "none"; // recently active, or too large to prove idle
        if (now - newest >= options.retentionMs) return "home";
        return (await exists(path.join(full, TEMP_DIR))) || (await listTempLeftovers(full)).length > 0 ? "temp" : "none";
      };
      if ((await inspectCodexHomeLeases(full, options)) !== "idle") { report.skippedInUse += 1; continue; }
      if ((await decide()) === "none") continue;

      try {
        budget -= 1;
        const { outcome, garbage } = await reapUnderLock(full, options, decide);
        if (outcome === "in-use" || outcome === "locked-out") { report.skippedInUse += 1; continue; }
        if (garbage) {
          try {
            await fs.rm(garbage, { recursive: true, force: true });
          } catch (error) {
            fail(garbage, outcome === "home" ? "remove-home" : "remove-temp", error); // retried by a later pass
            continue;
          }
        }
        if (outcome === "home") report.homesRemoved.push(name);
        else if (outcome === "temp") {
          for (const leftover of await listTempLeftovers(full)) await fs.rm(leftover, { recursive: true, force: true });
          report.tempRemoved.push(name);
        }
      } catch (error) {
        // Another pass already moved or removed it: nothing left to do, not a failure.
        if (errCode(error) !== "ENOENT") fail(full, "prune", error);
      }
    }
    if (budget <= 0) report.truncated = true;
  }
  return report;
}
