import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { McpClient } from "./support/mcp-client.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function completedWorktreeJob(t) {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-cleanup-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  git(workingDir, ["init", "-b", "main"]);
  await writeFile(resolve(workingDir, "tracked.txt"), "base\n");
  git(workingDir, ["add", "tracked.txt"]);
  git(workingDir, [
    "-c",
    "user.name=Divisi Test",
    "-c",
    "user.email=test@divisi.invalid",
    "commit",
    "-m",
    "base",
  ]);
  await writeFile(
    workerPath,
    [
      'import { writeFile } from "node:fs/promises";',
      'import { resolve } from "node:path";',
      'await writeFile(resolve("worker-change.txt"), "preserved by snapshot\\n");',
      'process.stdout.write(process.cwd());',
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "fake",
          capability_summary: "A cleanup fixture Worker.",
          command: process.execPath,
          args: [workerPath],
          output_dialect: "plain",
        },
      ],
    }),
  );
  const client = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(async () => {
    await client.close();
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();
  const result = await client.callTool("delegate", {
    worker: "fake",
    task_brief: "Create a snapshotted change.",
    working_dir: workingDir,
    isolation: "worktree",
    wait_seconds: 15,
  });
  return { client, result, workingDir, stateRoot, registryPath };
}

test("job_cleanup removes a finished worktree but preserves its unmerged branch", async (t) => {
  const { client, result, workingDir } = await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);

  const cleanup = await client.callTool("job_cleanup", { job_id: jobId });

  assert.deepEqual(cleanup, {
    job_id: jobId,
    worktree_removed: true,
    branch: result.branch,
    branch_deleted: false,
  });
  await assert.rejects(stat(result.final_message));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
});

test("job_cleanup deletes a branch only after git proves it merged", async (t) => {
  const { client, result, workingDir } = await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  git(workingDir, ["merge", "--ff-only", result.branch]);

  const cleanup = await client.callTool("job_cleanup", { job_id: jobId });

  assert.deepEqual(cleanup, {
    job_id: jobId,
    worktree_removed: true,
    branch: result.branch,
    branch_deleted: true,
  });
  await assert.rejects(stat(result.final_message));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), "");
  assert.equal(
    (await import("node:fs/promises").then(({ readFile }) =>
      readFile(resolve(workingDir, "worker-change.txt"), "utf8"),
    )).replaceAll("\r\n", "\n"),
    "preserved by snapshot\n",
  );
});

test("job_cleanup drops an unmerged branch only when discard is explicit", async (t) => {
  const { client, result, workingDir } = await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);

  const cleanup = await client.callTool("job_cleanup", {
    job_id: jobId,
    discard: true,
  });

  assert.deepEqual(cleanup, {
    job_id: jobId,
    worktree_removed: true,
    branch: result.branch,
    branch_deleted: true,
  });
  await assert.rejects(stat(result.final_message));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), "");
});

test("job_cleanup rejects path-shaped job ids before reading outside the Job store", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-cleanup-id-"));
  const stateRoot = resolve(fixture, "state");
  const sentinel = resolve(stateRoot, "outside.json");
  await mkdir(stateRoot);
  await writeFile(sentinel, "do not read or remove\n");
  const client = new McpClient({
    cwd: repoRoot,
    env: {
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(async () => {
    await client.close();
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();

  await assert.rejects(
    client.callTool("job_cleanup", {
      job_id: "../../outside",
      discard: true,
    }),
    /invalid job id/,
  );
  assert.equal(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(sentinel, "utf8"),
    ),
    "do not read or remove\n",
  );
});

test("job_cleanup refuses a running Delegation without touching its worktree or branch", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-cleanup-running-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  git(workingDir, ["init", "-b", "main"]);
  await writeFile(resolve(workingDir, "tracked.txt"), "base\n");
  git(workingDir, ["add", "tracked.txt"]);
  git(workingDir, [
    "-c",
    "user.name=Divisi Test",
    "-c",
    "user.email=test@divisi.invalid",
    "commit",
    "-m",
    "base",
  ]);
  await writeFile(
    workerPath,
    [
      "process.stdout.write(process.cwd());",
      "await new Promise((resolve) => setTimeout(resolve, 1_500));",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "fake",
          capability_summary: "A running cleanup fixture Worker.",
          command: process.execPath,
          args: [workerPath],
          output_dialect: "plain",
        },
      ],
    }),
  );
  const client = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(async () => {
    await client.close();
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();
  const pending = await client.callTool("delegate", {
    worker: "fake",
    task_brief: "Stay running.",
    working_dir: workingDir,
    isolation: "worktree",
    wait_seconds: 0,
  });
  const status = await client.callTool("job_status", pending);

  await assert.rejects(client.callTool("job_cleanup", pending), /running job/);
  assert.equal((await stat(status.working_dir)).isDirectory(), true);
  assert.equal(
    git(workingDir, ["branch", "--list", `divisi/${pending.job_id}`]).replace(/^\+\s+/, ""),
    `divisi/${pending.job_id}`,
  );

  let result = pending;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    result = await client.callTool("job_result", pending);
    if (result.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(result.status, "completed");
  await client.callTool("job_cleanup", {
    ...pending,
    discard: true,
  });
});

test("job_cleanup is idempotent when the worktree directory is already missing", async (t) => {
  const { client, result, workingDir } = await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);

  await client.callTool("job_cleanup", { job_id: jobId });
  const repeated = await client.callTool("job_cleanup", { job_id: jobId });

  assert.deepEqual(repeated, {
    job_id: jobId,
    worktree_removed: false,
    branch: result.branch,
    branch_deleted: false,
  });
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
  await client.callTool("job_cleanup", {
    job_id: jobId,
    discard: true,
  });
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), "");
  const missingAgain = await client.callTool("job_cleanup", {
    job_id: jobId,
    discard: true,
  });
  assert.equal(missingAgain.branch_deleted, false);
});

test("server startup sweeps expired finished artifacts and merged job branches", async (t) => {
  const { client, result, workingDir, stateRoot, registryPath } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  git(workingDir, ["merge", "--ff-only", result.branch]);
  await client.close();
  const markerPath = resolve(stateRoot, "divisi", "retention-sweep.json");
  await rm(markerPath);

  const freshClient = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      DIVISI_WORKTREE_RETENTION_DAYS: "0",
      DIVISI_RECORD_RETENTION_DAYS: "0",
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(() => freshClient.close());
  await freshClient.initialize();

  await assert.rejects(stat(result.final_message));
  await assert.rejects(stat(result.log_path));
  await assert.rejects(stat(jobPath));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), "");
  assert.equal(
    (await readFile(resolve(workingDir, "worker-change.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
    "preserved by snapshot\n",
  );
  const marker = JSON.parse(
    await readFile(markerPath, "utf8"),
  );
  assert.equal(typeof marker.last_run_at, "string");
});

test("Retention sweep never deletes an unmerged branch regardless of age", async (t) => {
  const { client, result, workingDir, stateRoot, registryPath } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  await client.close();
  await rm(resolve(stateRoot, "divisi", "retention-sweep.json"));

  const freshClient = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      DIVISI_WORKTREE_RETENTION_DAYS: "0",
      DIVISI_RECORD_RETENTION_DAYS: "0",
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(() => freshClient.close());
  await freshClient.initialize();

  await assert.rejects(stat(result.final_message));
  await assert.rejects(stat(result.log_path));
  await assert.rejects(stat(jobPath));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
  assert.equal(
    git(workingDir, ["show", `${result.branch}:worker-change.txt`]).replaceAll(
      "\r\n",
      "\n",
    ),
    "preserved by snapshot",
  );
});

test("Retention sweep runs at most daily across immediate server restarts", async (t) => {
  const { client, result, workingDir, stateRoot, registryPath } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  const markerPath = resolve(stateRoot, "divisi", "retention-sweep.json");
  const markerBefore = await readFile(markerPath, "utf8");
  await client.close();

  const immediateClient = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      DIVISI_WORKTREE_RETENTION_DAYS: "0",
      DIVISI_RECORD_RETENTION_DAYS: "0",
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(() => immediateClient.close());
  await immediateClient.initialize();

  assert.equal((await stat(result.final_message)).isDirectory(), true);
  assert.equal((await stat(result.log_path)).isFile(), true);
  assert.equal((await stat(jobPath)).isFile(), true);
  assert.equal(
    git(workingDir, ["branch", "--list", result.branch]).replace(/^\+\s+/, ""),
    result.branch,
  );
  assert.equal(await readFile(markerPath, "utf8"), markerBefore);

  await immediateClient.callTool("job_cleanup", {
    job_id: jobId,
    discard: true,
  });
});

test("divisi clean lists reclaimable items and changes nothing by default", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  await client.close();

  const clean = spawnSync(process.execPath, ["dist/cli.js", "clean"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
    windowsHide: true,
  });

  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, new RegExp(`worktree\\s+${jobId}`));
  assert.match(clean.stdout, new RegExp(`log\\s+${jobId}`));
  assert.match(clean.stdout, new RegExp(`record\\s+${jobId}`));
  assert.match(
    clean.stdout,
    new RegExp(`protected-unmerged-branch\\s+${result.branch}`),
  );
  assert.match(clean.stdout, /Dry run: no changes made/);
  assert.equal((await stat(result.final_message)).isDirectory(), true);
  assert.equal((await stat(result.log_path)).isFile(), true);
  assert.equal((await stat(jobPath)).isFile(), true);
  assert.equal(
    git(workingDir, ["branch", "--list", result.branch]).replace(/^\+\s+/, ""),
    result.branch,
  );
});

test("divisi clean --yes reclaims safe items while preserving unmerged branches", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  await client.close();

  const clean = spawnSync(process.execPath, ["dist/cli.js", "clean", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
    windowsHide: true,
  });

  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Cleanup complete; unmerged branches were preserved/);
  await assert.rejects(stat(result.final_message));
  await assert.rejects(stat(result.log_path));
  await assert.rejects(stat(jobPath));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
  assert.equal(
    git(workingDir, ["show", `${result.branch}:worker-change.txt`]).replaceAll(
      "\r\n",
      "\n",
    ),
    "preserved by snapshot",
  );
});

test("divisi clean --drop-unmerged still requires separate confirmation", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  await client.close();

  const clean = spawnSync(
    process.execPath,
    ["dist/cli.js", "clean", "--drop-unmerged"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LOCALAPPDATA: stateRoot,
        XDG_STATE_HOME: stateRoot,
      },
      windowsHide: true,
    },
  );

  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Dry run: no changes made/);
  assert.equal((await stat(result.final_message)).isDirectory(), true);
  assert.equal((await stat(result.log_path)).isFile(), true);
  assert.equal((await stat(jobPath)).isFile(), true);
  assert.equal(
    git(workingDir, ["branch", "--list", result.branch]).replace(/^\+\s+/, ""),
    result.branch,
  );
});

test("divisi clean drops unmerged work only with confirmation and capability flags", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  await client.close();

  const clean = spawnSync(
    process.execPath,
    ["dist/cli.js", "clean", "--yes", "--drop-unmerged"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LOCALAPPDATA: stateRoot,
        XDG_STATE_HOME: stateRoot,
      },
      windowsHide: true,
    },
  );

  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /unmerged branches were explicitly eligible/);
  await assert.rejects(stat(result.final_message));
  await assert.rejects(stat(result.log_path));
  await assert.rejects(stat(jobPath));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), "");
});

test("divisi clean accepts an interactive yes without granting unmerged deletion", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  await client.close();

  const clean = spawnSync(process.execPath, ["dist/cli.js", "clean"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
    input: "yes\n",
    windowsHide: true,
  });

  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Apply safe cleanup\? \[y\/N\]/);
  assert.match(clean.stdout, /Cleanup complete; unmerged branches were preserved/);
  await assert.rejects(stat(result.final_message));
  await assert.rejects(stat(result.log_path));
  await assert.rejects(stat(jobPath));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
  assert.equal(
    git(workingDir, ["show", `${result.branch}:worker-change.txt`]).replaceAll(
      "\r\n",
      "\n",
    ),
    "preserved by snapshot",
  );
});

test("Retention defaults remove worktrees after 7 days and logs and records after 30", async (t) => {
  const { client, result, workingDir, stateRoot, registryPath } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  const markerPath = resolve(stateRoot, "divisi", "retention-sweep.json");
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  const record = JSON.parse(await readFile(jobPath, "utf8"));
  await writeFile(
    jobPath,
    JSON.stringify({
      ...record,
      finished_at: eightDaysAgo.toISOString(),
    }),
  );
  await client.close();
  await rm(markerPath);

  const dayEightClient = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  await dayEightClient.initialize();

  await assert.rejects(stat(result.final_message));
  assert.equal((await stat(result.log_path)).isFile(), true);
  assert.equal((await stat(jobPath)).isFile(), true);
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
  await dayEightClient.close();

  const agedRecord = JSON.parse(await readFile(jobPath, "utf8"));
  await writeFile(
    jobPath,
    JSON.stringify({
      ...agedRecord,
      finished_at: new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1_000,
      ).toISOString(),
    }),
  );
  await rm(markerPath);
  const dayThirtyOneClient = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(() => dayThirtyOneClient.close());
  await dayThirtyOneClient.initialize();

  await assert.rejects(stat(result.log_path));
  await assert.rejects(stat(jobPath));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
  assert.equal(
    git(workingDir, ["show", `${result.branch}:worker-change.txt`]).replaceAll(
      "\r\n",
      "\n",
    ),
    "preserved by snapshot",
  );
});

test("cleanup fails closed when persisted worktree metadata escapes the state root", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  const sentinelDirectory = resolve(stateRoot, "outside-state-worktree");
  const sentinel = resolve(sentinelDirectory, "sentinel.txt");
  await mkdir(sentinelDirectory);
  await writeFile(sentinel, "must survive\n");
  const record = JSON.parse(await readFile(jobPath, "utf8"));
  await writeFile(
    jobPath,
    JSON.stringify({
      ...record,
      worktree_path: sentinelDirectory,
    }),
  );
  await client.close();

  const clean = spawnSync(
    process.execPath,
    ["dist/cli.js", "clean", "--yes", "--drop-unmerged"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LOCALAPPDATA: stateRoot,
        XDG_STATE_HOME: stateRoot,
      },
      windowsHide: true,
    },
  );

  assert.equal(clean.status, 1);
  assert.match(clean.stderr, /Refusing cleanup outside the Divisi state root/);
  assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
  assert.equal((await stat(result.final_message)).isDirectory(), true);
  assert.equal((await stat(result.log_path)).isFile(), true);
  assert.equal((await stat(jobPath)).isFile(), true);
  assert.equal(
    git(workingDir, ["branch", "--list", result.branch]).replace(/^\+\s+/, ""),
    result.branch,
  );
});

test("divisi clean --yes deletes a branch git proves merged", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  git(workingDir, ["merge", "--ff-only", result.branch]);
  await client.close();

  const clean = spawnSync(process.execPath, ["dist/cli.js", "clean", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
    windowsHide: true,
  });

  assert.equal(clean.status, 0, clean.stderr);
  await assert.rejects(stat(result.final_message));
  await assert.rejects(stat(result.log_path));
  await assert.rejects(stat(jobPath));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), "");
  assert.equal(
    (await readFile(resolve(workingDir, "worker-change.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
    "preserved by snapshot\n",
  );
});

test("server startup rejects invalid Retention configuration before touching state", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-retention-config-"));
  const stateRoot = resolve(fixture, "state");
  const stateDirectory = resolve(stateRoot, "divisi");
  const markerPath = resolve(stateDirectory, "retention-sweep.json");
  const marker = JSON.stringify({ last_run_at: new Date().toISOString() });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(markerPath, marker);
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const server = spawnSync(process.execPath, ["dist/cli.js", "serve"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DIVISI_WORKTREE_RETENTION_DAYS: "-1",
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
    input:
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }) + "\n",
    windowsHide: true,
  });

  assert.equal(server.status, 1);
  assert.equal(server.stdout, "");
  assert.match(
    server.stderr,
    /^Could not start Divisi: DIVISI_WORKTREE_RETENTION_DAYS must be a non-negative number\r?\n$/,
  );
  assert.equal(await readFile(markerPath, "utf8"), marker);
});

test("cleanup preflights every log target before deleting any artifact", async (t) => {
  const { client, result, workingDir, stateRoot } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  const sentinel = resolve(stateRoot, "outside-state.log");
  await writeFile(sentinel, "must survive\n");
  const record = JSON.parse(await readFile(jobPath, "utf8"));
  await writeFile(
    jobPath,
    JSON.stringify({
      ...record,
      log_path: sentinel,
    }),
  );
  await client.close();

  const clean = spawnSync(
    process.execPath,
    ["dist/cli.js", "clean", "--yes", "--drop-unmerged"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LOCALAPPDATA: stateRoot,
        XDG_STATE_HOME: stateRoot,
      },
      windowsHide: true,
    },
  );

  assert.equal(clean.status, 1);
  assert.match(clean.stderr, /Refusing cleanup outside the Divisi logs directory/);
  assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
  assert.equal((await stat(result.final_message)).isDirectory(), true);
  assert.equal((await stat(jobPath)).isFile(), true);
  assert.equal(
    git(workingDir, ["branch", "--list", result.branch]).replace(/^\+\s+/, ""),
    result.branch,
  );
});

test("Retention sweep never follows a tampered log path outside state", async (t) => {
  const { client, result, workingDir, stateRoot, registryPath } =
    await completedWorktreeJob(t);
  const jobId = result.branch.slice("divisi/".length);
  const jobPath = resolve(stateRoot, "divisi", "jobs", `${jobId}.json`);
  const markerPath = resolve(stateRoot, "divisi", "retention-sweep.json");
  const originalLogPath = result.log_path;
  const sentinel = resolve(stateRoot, "outside-retention.log");
  await writeFile(sentinel, "must survive\n");
  const record = JSON.parse(await readFile(jobPath, "utf8"));
  await writeFile(
    jobPath,
    JSON.stringify({
      ...record,
      log_path: sentinel,
    }),
  );
  await client.close();
  await rm(markerPath);

  const freshClient = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      DIVISI_WORKTREE_RETENTION_DAYS: "0",
      DIVISI_RECORD_RETENTION_DAYS: "0",
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(() => freshClient.close());
  await freshClient.initialize();

  assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
  assert.equal((await stat(originalLogPath)).isFile(), true);
  assert.equal((await stat(jobPath)).isFile(), true);
  await assert.rejects(stat(result.final_message));
  assert.equal(git(workingDir, ["branch", "--list", result.branch]), result.branch);
  assert.equal(
    typeof JSON.parse(await readFile(markerPath, "utf8")).last_run_at,
    "string",
  );
});

test("Retention sweep skips a corrupt record and still persists its daily marker", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-retention-corrupt-"));
  const stateRoot = resolve(fixture, "state");
  const stateDirectory = resolve(stateRoot, "divisi");
  const jobsDirectory = resolve(stateDirectory, "jobs");
  const corruptPath = resolve(
    jobsDirectory,
    "11111111-1111-4111-8111-111111111111.json",
  );
  await mkdir(jobsDirectory, { recursive: true });
  await writeFile(corruptPath, "{ definitely not a Job record");
  const client = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKTREE_RETENTION_DAYS: "0",
      DIVISI_RECORD_RETENTION_DAYS: "0",
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  t.after(async () => {
    await client.close();
    await rm(fixture, { recursive: true, force: true });
  });

  await client.initialize();

  assert.equal(await readFile(corruptPath, "utf8"), "{ definitely not a Job record");
  const marker = JSON.parse(
    await readFile(resolve(stateDirectory, "retention-sweep.json"), "utf8"),
  );
  assert.equal(typeof marker.last_run_at, "string");
});
