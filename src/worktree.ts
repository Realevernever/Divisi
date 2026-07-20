import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type WorktreeJobFields = {
  job_id: string;
  working_dir: string;
  isolation?: "in_place" | "worktree";
  branch?: string;
  base_commit?: string;
  orchestrator_working_dir?: string;
  worktree_path?: string;
};

export type WorktreeSetup = {
  branch: string;
  baseCommit: string;
  repoRoot: string;
  worktreePath: string;
  workingDir: string;
};

export type WorktreeCleanupResult = {
  job_id: string;
  worktree_removed: boolean;
  branch: string;
  branch_deleted: boolean;
};

type WorktreeCleanupTarget = {
  branch: string;
  repoRoot: string;
  expectedWorktreePath: string;
};

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repositoryKey(repoRoot: string): string {
  return createHash("sha256")
    .update(process.platform === "win32" ? repoRoot.toLowerCase() : repoRoot)
    .digest("hex")
    .slice(0, 16);
}

export function createDelegationWorktree(
  requestedWorkingDir: string,
  jobId: string,
  stateDirectory: string,
): WorktreeSetup {
  const resolvedWorkingDir = resolve(requestedWorkingDir);
  let repoRoot: string;
  let baseCommit: string;
  try {
    repoRoot = resolve(
      gitOutput(resolvedWorkingDir, ["rev-parse", "--show-toplevel"]),
    );
    baseCommit = gitOutput(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(
      `Worktree isolation requires a git repository with a commit: ${resolvedWorkingDir}`,
    );
  }

  const relativeWorkingDir = relative(repoRoot, resolvedWorkingDir);
  if (
    relativeWorkingDir === ".." ||
    relativeWorkingDir.startsWith("../") ||
    relativeWorkingDir.startsWith("..\\")
  ) {
    throw new Error(
      `Working directory is outside its git repository: ${resolvedWorkingDir}`,
    );
  }
  const key = repositoryKey(repoRoot);
  const branch = `divisi/${jobId}`;
  const worktreesDirectory = join(stateDirectory, "worktrees", key);
  const worktreePath = join(worktreesDirectory, jobId);
  try {
    statSync(worktreePath);
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const branchExists =
    spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoRoot, windowsHide: true, stdio: "ignore" },
    ).status === 0;
  if (branchExists) {
    throw new Error(`Worktree branch already exists: ${branch}`);
  }

  mkdirSync(worktreesDirectory, { recursive: true });
  try {
    execFileSync(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, baseCommit],
      {
        cwd: repoRoot,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  } catch (error) {
    const stderr =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    throw new Error(
      `Could not create worktree ${worktreePath}: ${oneLine(stderr) || "git worktree add failed"}`,
    );
  }
  return {
    branch,
    baseCommit,
    repoRoot,
    worktreePath,
    workingDir: resolve(worktreePath, relativeWorkingDir),
  };
}

export function snapshotWorktree(job: WorktreeJobFields): void {
  if (job.isolation !== "worktree") return;
  const status = gitOutput(job.working_dir, ["status", "--porcelain"]);
  if (!status) return;
  execFileSync("git", ["add", "--all"], {
    cwd: job.working_dir,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Divisi",
      "-c",
      "user.email=snapshot@divisi.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-m",
      `Snapshot ${job.job_id}`,
    ],
    {
      cwd: job.working_dir,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

export function gitChangeSummary(job: WorktreeJobFields): string {
  try {
    const range = job.base_commit ? [`${job.base_commit}..HEAD`] : [];
    return execFileSync(
      "git",
      ["diff", "--stat", "--no-ext-diff", ...range],
      {
        cwd: job.working_dir,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return "";
  }
}

function isMissingPath(path: string): boolean {
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

export function validateWorktreeCleanup(
  job: WorktreeJobFields,
  stateDirectory: string,
): WorktreeCleanupTarget {
  if (job.isolation !== "worktree") {
    throw new Error(`Job has no Worktree Delegation: ${job.job_id}`);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      job.job_id,
    )
  ) {
    throw new Error("Refusing cleanup for an invalid job id");
  }
  const branch = `divisi/${job.job_id}`;
  if (job.branch !== branch) {
    throw new Error(
      `Refusing cleanup outside branch namespace: ${String(job.branch)}`,
    );
  }
  if (!job.orchestrator_working_dir || !job.worktree_path) {
    throw new Error(`Job is missing Worktree cleanup metadata: ${job.job_id}`);
  }
  const repoRoot = resolve(job.orchestrator_working_dir);
  let actualRepoRoot: string;
  try {
    actualRepoRoot = resolve(
      gitOutput(repoRoot, ["rev-parse", "--show-toplevel"]),
    );
  } catch {
    throw new Error(
      `Refusing cleanup for an unavailable repository: ${repoRoot}`,
    );
  }
  if (actualRepoRoot !== repoRoot) {
    throw new Error(
      `Refusing cleanup outside the recorded repository: ${repoRoot}`,
    );
  }
  const expectedWorktreePath = resolve(
    stateDirectory,
    "worktrees",
    repositoryKey(repoRoot),
    job.job_id,
  );
  if (resolve(job.worktree_path) !== expectedWorktreePath) {
    throw new Error(
      `Refusing cleanup outside the Divisi state root: ${job.worktree_path}`,
    );
  }
  return {
    branch,
    repoRoot,
    expectedWorktreePath,
  };
}

export function cleanupWorktree(
  job: WorktreeJobFields,
  stateDirectory: string,
  discard: boolean,
): WorktreeCleanupResult {
  const { branch, repoRoot, expectedWorktreePath } =
    validateWorktreeCleanup(job, stateDirectory);
  const worktreeRemoved = !isMissingPath(expectedWorktreePath);
  if (worktreeRemoved) {
    execFileSync("git", ["worktree", "remove", "--force", expectedWorktreePath], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } else {
    execFileSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  const branchExists =
    spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoRoot, windowsHide: true, stdio: "ignore" },
    ).status === 0;
  const merged =
    branchExists &&
    spawnSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: "ignore",
    }).status === 0;
  const branchDeleted = branchExists && (merged || discard);
  if (branchDeleted) {
    execFileSync("git", ["branch", discard ? "-D" : "-d", "--", branch], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  return {
    job_id: job.job_id,
    worktree_removed: worktreeRemoved,
    branch,
    branch_deleted: branchDeleted,
  };
}
