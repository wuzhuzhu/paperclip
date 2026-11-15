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
 */
export const GENERATED_HOME_KINDS = ["skill-runtimes", "connector-runtimes"] as const;
export type GeneratedHomeKind = (typeof GENERATED_HOME_KINDS)[number];

export const LEASE_DIR_NAME = ".paperclip-leases";
export const LAST_USED_FILE = ".paperclip-last-used";
const DIGEST_DIR = /^[a-f0-9]{64}$/;
const REAPING_DIR = /^[a-f0-9]{64}\.reaping-[a-f0-9]{8}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CodexHomeLifecycleOptions {
  retentionMs: number;
  tempGraceMs: number;
  /** Backstop for a lease whose process is still alive but which was never released. */
  maxLeaseMs: number;
  /** Total removals (temp dirs + whole homes) per pass; keeps a run's tail latency bounded. */
  maxOperationsPerPass: number;
  /** Entries inspected per home when looking for recent activity; past it the home counts as active. */
  maxScanEntries: number;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  /** Test seam: runs after a home was renamed away and before it is deleted. */
  afterRename?: (renamed: string) => Promise<void>;
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
    maxLeaseMs: 2 * DAY_MS,
    maxOperationsPerPass: 25,
    maxScanEntries: 20_000,
    now: Date.now,
    isPidAlive: defaultIsPidAlive,
    ...overrides,
  };
}

/** Deleting the plugin clone at run end is on by default; set to keep it between runs. */
export function shouldDropPluginCloneAfterRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_CODEX_KEEP_PLUGIN_CACHE !== "1" && env.PAPERCLIP_CODEX_KEEP_PLUGIN_CACHE !== "true";
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
 * Registers a run in the home. Returns null when the lease could not be written;
 * callers then skip every destructive step for this home (fail closed).
 */
export async function acquireCodexHomeLease(
  home: string,
  runId: string,
  options: Pick<CodexHomeLifecycleOptions, "now" | "maxLeaseMs" | "isPidAlive"> = resolveCodexHomeLifecycleOptions(),
): Promise<CodexHomeLease | null> {
  const dir = path.join(home, LEASE_DIR_NAME);
  const name = `${runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "run"}-${randomBytes(4).toString("hex")}.json`;
  const file = path.join(dir, name);
  try {
    await fs.mkdir(dir, { recursive: true });
    const record: LeaseRecord = { pid: process.pid, runId, startedAt: options.now() };
    await fs.writeFile(file, JSON.stringify(record));
    await touchCodexHomeLastUsed(home, options.now);
  } catch {
    await fs.rm(file, { force: true }).catch(() => undefined);
    return null;
  }
  return {
    home,
    release: async () => {
      await fs.rm(file, { force: true }).catch(() => undefined);
      await touchCodexHomeLastUsed(home, options.now);
      return (await inspectCodexHomeLeases(home, options)) === "idle";
    },
  };
}

/**
 * "idle": provably no live run. "busy": a live lease exists. "unknown": the lease
 * state could not be read; destructive callers must treat it like "busy".
 */
export async function inspectCodexHomeLeases(
  home: string,
  options: Pick<CodexHomeLifecycleOptions, "now" | "maxLeaseMs" | "isPidAlive"> = resolveCodexHomeLifecycleOptions(),
): Promise<"idle" | "busy" | "unknown"> {
  const dir = path.join(home, LEASE_DIR_NAME);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "idle" : "unknown";
  }
  let state: "idle" | "busy" | "unknown" = "idle";
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      state = "unknown";
      continue;
    }
    const age = options.now() - stat.mtimeMs;
    let record: LeaseRecord | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<LeaseRecord>;
      if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") record = parsed as LeaseRecord;
    } catch { /* corrupt or being written */ }
    const live = record
      ? options.isPidAlive(record.pid) && options.now() - record.startedAt <= options.maxLeaseMs
      : age <= options.maxLeaseMs; // unreadable lease: protect it until the backstop age
    if (live) return "busy";
    // Left by a crashed/killed process (or past the backstop): reclaim the file.
    await fs.rm(file, { force: true }).catch(() => { state = "unknown"; });
  }
  return state;
}

/**
 * Removes the Codex plugin marketplace clone (`.tmp`) from a home no run is using.
 * Codex re-creates it on demand; sessions, sqlite state and config are untouched.
 */
export async function removeIdleCodexHomeTemp(
  home: string,
  options: Pick<CodexHomeLifecycleOptions, "now" | "maxLeaseMs" | "isPidAlive"> = resolveCodexHomeLifecycleOptions(),
): Promise<boolean> {
  if ((await inspectCodexHomeLeases(home, options)) !== "idle") return false;
  const target = path.join(home, ".tmp");
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return false;
  // rm never follows a symlink: a `.tmp` link is removed as a link, not its target.
  await fs.rm(target, { recursive: true, force: true });
  return true;
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return Infinity;
    }
    for (const entry of entries) {
      // Disposable cache and our own bookkeeping say nothing about session use.
      if (dir === home && (entry.name === ".tmp" || entry.name === LEASE_DIR_NAME || entry.name === LAST_USED_FILE)) continue;
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
  const now = options.now();

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
        // A previous pass died between rename and delete. Same bounded, contained removal.
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

      const lease = await inspectCodexHomeLeases(full, options);
      if (lease !== "idle") { report.skippedInUse += 1; continue; }
      const newest = await newestActivityMs(full, now - options.tempGraceMs, options.maxScanEntries);
      if (newest >= now - options.tempGraceMs) continue; // recently active, or too large to prove idle

      try {
        if (now - newest >= options.retentionMs) {
          budget -= 1;
          const moved = `${full}.reaping-${randomBytes(4).toString("hex")}`;
          await fs.rename(full, moved);
          await options.afterRename?.(moved);
          // A run may have leased the home between the check and the rename.
          if ((await inspectCodexHomeLeases(moved, options)) !== "idle") {
            await fs.rename(moved, full).catch((error) => fail(moved, "restore", error));
            report.skippedInUse += 1;
            continue;
          }
          try {
            await fs.rm(moved, { recursive: true, force: true });
            report.homesRemoved.push(name);
          } catch (error) {
            fail(moved, "remove-home", error); // the *.reaping-* leftover is retried next pass
          }
        } else if (stat && (await fs.lstat(path.join(full, ".tmp")).catch(() => null))) {
          budget -= 1;
          if (await removeIdleCodexHomeTemp(full, options)) report.tempRemoved.push(name);
        }
      } catch (error) {
        // Another pass already moved or removed it: nothing left to do, not a failure.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(full, "prune", error);
      }
    }
    if (budget <= 0) report.truncated = true;
  }
  return report;
}
