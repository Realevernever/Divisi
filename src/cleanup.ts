import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { replaceFileSync } from "./atomic-file.js";
import {
  cleanupWorktree,
  validateWorktreeCleanup,
  type WorktreeJobFields,
} from "./worktree.js";

const dayMilliseconds = 24 * 60 * 60 * 1_000;
const terminalStatuses = new Set([
  "completed",
  "failed",
  "timeout",
  "canceled",
]);
const jobIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredJob = WorktreeJobFields & {
  status: string;
  finished_at?: string;
  log_path?: string;
};

function configuredDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function missing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return true;
    }
    throw error;
  }
}

function writeMarker(stateDirectory: string, markerPath: string): void {
  mkdirSync(stateDirectory, { recursive: true });
  const temporaryPath = join(
    stateDirectory,
    `.retention-sweep.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(
    temporaryPath,
    JSON.stringify({ last_run_at: new Date().toISOString() }),
  );
  replaceFileSync(temporaryPath, markerPath);
}

export function retentionSweep(stateDirectory: string): void {
  const worktreeDays = configuredDays(
    "DIVISI_WORKTREE_RETENTION_DAYS",
    7,
  );
  const recordDays = configuredDays("DIVISI_RECORD_RETENTION_DAYS", 30);
  const markerPath = join(stateDirectory, "retention-sweep.json");
  if (!missing(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        last_run_at?: string;
      };
      const lastRun = Date.parse(String(marker.last_run_at));
      if (Number.isFinite(lastRun) && Date.now() - lastRun < dayMilliseconds) {
        return;
      }
    } catch {}
  }

  const jobsDirectory = join(stateDirectory, "jobs");
  let names: string[] = [];
  try {
    names = readdirSync(jobsDirectory);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  for (const name of names) {
    const match = /^([0-9a-f-]+)\.json$/i.exec(name);
    if (!match) continue;
    const jobId = match[1];
    if (!jobId || !jobIdPattern.test(jobId)) continue;
    const jobPath = join(jobsDirectory, name);
    let job: StoredJob;
    try {
      job = JSON.parse(readFileSync(jobPath, "utf8")) as StoredJob;
    } catch {
      continue;
    }
    if (job.job_id !== jobId || !terminalStatuses.has(job.status)) continue;
    const finishedAt = Date.parse(String(job.finished_at));
    if (!Number.isFinite(finishedAt)) continue;
    const age = Date.now() - finishedAt;

    if (job.isolation === "worktree" && age >= worktreeDays * dayMilliseconds) {
      try {
        cleanupWorktree(job, stateDirectory, false);
      } catch {
        continue;
      }
    }

    if (age < recordDays * dayMilliseconds) continue;
    const expectedLogPath = resolve(stateDirectory, "logs", `${jobId}.log`);
    if (
      typeof job.log_path !== "string" ||
      resolve(job.log_path) !== expectedLogPath
    ) {
      continue;
    }
    if (!missing(expectedLogPath)) unlinkSync(expectedLogPath);
    unlinkSync(jobPath);
  }

  writeMarker(stateDirectory, markerPath);
}

type CleanupOptions = {
  apply: boolean;
  dropUnmerged: boolean;
};

function storedJobs(stateDirectory: string): Array<{
  job: StoredJob;
  jobPath: string;
}> {
  const jobsDirectory = join(stateDirectory, "jobs");
  let names: string[];
  try {
    names = readdirSync(jobsDirectory);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const match = /^([0-9a-f-]+)\.json$/i.exec(name);
    const jobId = match?.[1];
    if (!jobId || !jobIdPattern.test(jobId)) return [];
    const jobPath = join(jobsDirectory, name);
    try {
      const job = JSON.parse(readFileSync(jobPath, "utf8")) as StoredJob;
      return job.job_id === jobId && terminalStatuses.has(job.status)
        ? [{ job, jobPath }]
        : [];
    } catch {
      return [];
    }
  });
}

function exactLogPath(
  stateDirectory: string,
  job: StoredJob,
): string | undefined {
  const expected = resolve(stateDirectory, "logs", `${job.job_id}.log`);
  return typeof job.log_path === "string" &&
    resolve(job.log_path) === expected
    ? expected
    : undefined;
}

function listedWorktreePath(
  stateDirectory: string,
  job: StoredJob,
): string | undefined {
  if (job.isolation !== "worktree" || !job.worktree_path) return undefined;
  const root = `${resolve(stateDirectory, "worktrees")}${sep}`;
  const candidate = resolve(job.worktree_path);
  return candidate.startsWith(root) &&
    basename(candidate).toLowerCase() === job.job_id.toLowerCase() &&
    !missing(candidate)
    ? candidate
    : undefined;
}

function branchKind(job: StoredJob): "merged" | "unmerged" | undefined {
  const branch = `divisi/${job.job_id}`;
  if (
    job.isolation !== "worktree" ||
    job.branch !== branch ||
    !job.orchestrator_working_dir
  ) {
    return undefined;
  }
  const cwd = resolve(job.orchestrator_working_dir);
  const exists =
    spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd, windowsHide: true, stdio: "ignore" },
    ).status === 0;
  if (!exists) return undefined;
  return spawnSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], {
    cwd,
    windowsHide: true,
    stdio: "ignore",
  }).status === 0
    ? "merged"
    : "unmerged";
}

export function deepClean(
  stateDirectory: string,
  options: CleanupOptions,
): string[] {
  const lines: string[] = [];
  const entries = storedJobs(stateDirectory);
  if (options.apply) {
    for (const { job } of entries) {
      if (!exactLogPath(stateDirectory, job)) {
        throw new Error(
          `Refusing cleanup outside the Divisi logs directory: ${String(job.log_path)}`,
        );
      }
      if (job.isolation === "worktree") {
        validateWorktreeCleanup(job, stateDirectory);
      }
    }
  }

  for (const { job, jobPath } of entries) {
    const worktreePath = listedWorktreePath(stateDirectory, job);
    const logPath = exactLogPath(stateDirectory, job);
    const kind = branchKind(job);
    if (worktreePath) lines.push(`worktree ${job.job_id} ${worktreePath}`);
    if (logPath && !missing(logPath)) lines.push(`log ${job.job_id} ${logPath}`);
    lines.push(`record ${job.job_id} ${jobPath}`);
    if (kind === "merged") lines.push(`merged-branch ${job.branch}`);
    if (kind === "unmerged") {
      lines.push(`protected-unmerged-branch ${job.branch}`);
    }
    if (!options.apply) continue;

    if (job.isolation === "worktree") {
      cleanupWorktree(job, stateDirectory, options.dropUnmerged);
    }
    if (!logPath) continue;
    if (!missing(logPath)) unlinkSync(logPath);
    unlinkSync(jobPath);
  }
  return lines;
}
