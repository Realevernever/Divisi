import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

import { McpClient } from "./support/mcp-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("an MCP client discovers the tracer-bullet tools", async (t) => {
  const client = new McpClient({ cwd: repoRoot });
  t.after(() => client.close());
  await client.initialize();

  const response = await client.request("tools/list");

  assert.deepEqual(
    response.tools.map((tool) => tool.name),
    [
      "delegate",
      "job_status",
      "job_result",
      "job_list",
      "job_cancel",
      "list_workers",
    ],
  );

  const delegate = response.tools.find((tool) => tool.name === "delegate");
  assert.deepEqual(delegate.inputSchema.properties.options, {
    type: "object",
    additionalProperties: { type: "string" },
  });
  assert.deepEqual(delegate.inputSchema.properties.isolation, {
    type: "string",
    enum: ["in_place", "worktree"],
  });
});

test("list_workers reports safe Worker option discovery without flag syntax", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-registry-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const registryPath = resolve(fixture, "workers.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "fake",
          capability_summary: "A scripted Worker for end-to-end tests.",
          command: process.execPath,
          args: ["fake-worker.mjs", "{task_brief}"],
          output_dialect: "plain",
          options: {
            effort: {
              values: ["low", "medium", "high"],
              flag: "--effort {value}",
              default: "high",
            },
          },
        },
      ],
    }),
  );
  const client = new McpClient({
    cwd: repoRoot,
    env: { DIVISI_WORKERS_FILE: registryPath },
  });
  t.after(() => client.close());
  await client.initialize();

  const workers = await client.callTool("list_workers");

  assert.deepEqual(workers, [
    {
      id: "fake",
      capability_summary: "A scripted Worker for end-to-end tests.",
      options: {
        effort: {
          values: ["low", "medium", "high"],
          default: "high",
        },
      },
    },
  ]);
  assert.equal(JSON.stringify(workers).includes("--effort"), false);
});

test("delegate returns a finished Worker's mechanical result verbatim", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-delegate-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "fake-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    [
      'import { writeFile } from "node:fs/promises";',
      'const taskBrief = process.argv[2];',
      'await writeFile("received-task.txt", taskBrief);',
      'await writeFile("tracked.txt", "changed by Worker\\n");',
      'process.stdout.write("FAILED marker\\nfinal line");',
    ].join("\n"),
  );
  await writeFile(resolve(workingDir, "tracked.txt"), "before\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: workingDir });
  execFileSync("git", ["config", "core.autocrlf", "false"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.email", "divisi@example.invalid"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Divisi Test"], {
    cwd: workingDir,
  });
  execFileSync("git", ["add", "tracked.txt"], { cwd: workingDir });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workingDir });
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "fake",
          capability_summary: "A scripted Worker for end-to-end tests.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
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
  const taskBrief = "Keep this exact.\nUnicode survives: Käfer 🪲";

  const result = await client.callTool("delegate", {
    worker: "fake",
    task_brief: taskBrief,
    working_dir: workingDir,
    wait_seconds: 15,
  });

  assert.deepEqual(Object.keys(result).sort(), [
    "duration_ms", "final_message", "git_diff_stat", "log_path", "status",
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.final_message, "FAILED marker\nfinal line");
  assert.match(result.git_diff_stat, /tracked\.txt/);
  assert.equal(typeof result.duration_ms, "number");
  assert.equal(await readFile(resolve(workingDir, "received-task.txt"), "utf8"), taskBrief);
  assert.equal(await readFile(result.log_path, "utf8"), result.final_message);
  assert.ok(result.log_path.startsWith(`${resolve(stateRoot, "divisi")}${sep}`));
  assert.equal(result.log_path.startsWith(`${workingDir}${sep}`), false);
  assert.ok((await readdir(resolve(stateRoot, "divisi", "jobs"))).length > 0);
});


test("worktree delegation snapshots Worker changes on an unmerged branch", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-worktree-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "worktree-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  let worktreePath;
  await mkdir(workingDir);
  await writeFile(resolve(workingDir, "tracked.txt"), "orchestrator copy\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: workingDir });
  execFileSync("git", ["add", "tracked.txt"], { cwd: workingDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Divisi Test",
      "-c",
      "user.email=divisi@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: workingDir },
  );
  const mainCommit = execFileSync("git", ["rev-parse", "main"], {
    cwd: workingDir,
    encoding: "utf8",
  }).trim();
  await writeFile(resolve(workingDir, "tracked.txt"), "orchestrator local\n");
  await writeFile(resolve(workingDir, "orchestrator-only.txt"), "stay local\n");
  const orchestratorStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: workingDir,
    encoding: "utf8",
  });
  assert.match(orchestratorStatus, /tracked\.txt/);
  assert.match(orchestratorStatus, /orchestrator-only\.txt/);
  await writeFile(
    workerPath,
    [
      'import { writeFile } from "node:fs/promises";',
      'await writeFile("worker-change.txt", "preserved by snapshot\\n");',
      "process.stdout.write(process.cwd());",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "worktree-fake",
          capability_summary: "A scripted Worker that edits its current tree.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
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
    if (worktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: workingDir,
        });
      } catch {}
    }
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();

  const result = await client.callTool("delegate", {
    worker: "worktree-fake",
    task_brief: "Edit only the isolated worktree.",
    working_dir: workingDir,
    isolation: "worktree",
    wait_seconds: 15,
  });
  worktreePath = result.final_message;

  assert.deepEqual(Object.keys(result).sort(), [
    "branch",
    "duration_ms",
    "final_message",
    "git_diff_stat",
    "log_path",
    "status",
  ]);
  assert.equal(result.status, "completed");
  assert.match(result.branch, /^divisi\/[0-9a-f-]+$/);
  assert.ok(worktreePath.startsWith(`${resolve(stateRoot, "divisi", "worktrees")}${sep}`));
  assert.notEqual(worktreePath, workingDir);
  assert.match(result.git_diff_stat, /worker-change\.txt/);
  await assert.rejects(readFile(resolve(workingDir, "worker-change.txt"), "utf8"));
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    orchestratorStatus,
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "main"], {
      cwd: workingDir,
      encoding: "utf8",
    }).trim(),
    mainCommit,
  );
  assert.match(
    execFileSync("git", ["log", "-1", "--format=%s", result.branch], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    /^Snapshot /,
  );
  assert.equal(
    execFileSync("git", ["show", `${result.branch}:worker-change.txt`], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "preserved by snapshot\n",
  );

  execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: workingDir,
  });
  worktreePath = undefined;
  assert.equal(
    execFileSync("git", ["show", `${result.branch}:worker-change.txt`], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "preserved by snapshot\n",
  );
  assert.equal(
    execFileSync("git", ["show", `${result.branch}:tracked.txt`], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "orchestrator copy\n",
  );
  assert.throws(() =>
    execFileSync("git", ["show", `${result.branch}:orchestrator-only.txt`], {
      cwd: workingDir,
      stdio: "ignore",
    }),
  );
});

test("job_result resolves a Delegation that outlives wait_seconds", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-async-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "slow-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    [
      'await new Promise((resolve) => setTimeout(resolve, 200));',
      'process.stdout.write("slow Worker final message");',
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "slow-fake",
          capability_summary: "A slow scripted Worker.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
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
    worker: "slow-fake",
    task_brief: "Run slowly.",
    working_dir: workingDir,
    wait_seconds: 0,
  });

  assert.deepEqual(Object.keys(pending), ["job_id"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await client.callTool("job_result", pending);
  assert.equal(result.status, "completed");
  assert.equal(result.final_message, "slow Worker final message");
});

test("a fresh server lists a running Delegation after its originating server is killed", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-detached-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "detached-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    [
      'process.stdout.write("Worker still running\\n");',
      'await new Promise((resolve) => setTimeout(resolve, 5_000));',
      'process.stdout.write("finished");',
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "detached-fake",
          capability_summary: "A detached scripted Worker.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
          output_dialect: "plain",
        },
      ],
    }),
  );
  const env = {
    DIVISI_WORKERS_FILE: registryPath,
    LOCALAPPDATA: stateRoot,
    XDG_STATE_HOME: stateRoot,
  };
  const first = new McpClient({ cwd: repoRoot, env });
  await first.initialize();
  const taskBrief = "Survive the server.";
  const pending = await first.callTool("delegate", {
    worker: "detached-fake",
    task_brief: taskBrief,
    working_dir: workingDir,
    wait_seconds: 0,
  });
  await first.close();

  const second = new McpClient({ cwd: repoRoot, env });
  t.after(async () => {
    await second.close();
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await rm(fixture, { recursive: true, force: true });
  });
  await second.initialize();

  const jobs = await second.callTool("job_list");

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_id, pending.job_id);
  assert.equal(jobs[0].worker, "detached-fake");
  assert.equal(jobs[0].status, "running");
  assert.equal(typeof jobs[0].pid, "number");
  assert.equal("controller_pid" in jobs[0], false);
  assert.equal("launch" in jobs[0], false);
  assert.equal("isolation" in jobs[0], false);
  assert.equal(jobs[0].working_dir, workingDir);
  assert.equal(jobs[0].task_brief, taskBrief);
  assert.match(jobs[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(jobs[0].started_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("job_status reports liveness and a recent-output tail while a Worker runs", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-status-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "talking-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    [
      'process.stdout.write("first progress line\\nsecond progress line\\n");',
      'await new Promise((resolve) => setTimeout(resolve, 2_500));',
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "talking-fake",
          capability_summary: "A scripted Worker that reports progress.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
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
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();
  const pending = await client.callTool("delegate", {
    worker: "talking-fake",
    task_brief: "Report progress.",
    working_dir: workingDir,
    wait_seconds: 0,
  });

  let status;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = await client.callTool("job_status", pending);
    if (status.recent_output.includes("second progress line")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(status.status, "running");
  assert.equal(status.alive, true);
  assert.match(status.recent_output, /first progress line\nsecond progress line/);
});

test("a fresh server returns the completed result after the Worker exits", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-recovery-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "finishing-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    [
      'await new Promise((resolve) => setTimeout(resolve, 300));',
      'process.stdout.write("survived and finished");',
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "finishing-fake",
          capability_summary: "A scripted Worker that finishes later.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
          output_dialect: "plain",
        },
      ],
    }),
  );
  const env = {
    DIVISI_WORKERS_FILE: registryPath,
    LOCALAPPDATA: stateRoot,
    XDG_STATE_HOME: stateRoot,
  };
  const first = new McpClient({ cwd: repoRoot, env });
  await first.initialize();
  const pending = await first.callTool("delegate", {
    worker: "finishing-fake",
    task_brief: "Finish without the server.",
    working_dir: workingDir,
    wait_seconds: 0,
  });
  await first.terminate();
  await new Promise((resolve) => setTimeout(resolve, 800));

  const second = new McpClient({ cwd: repoRoot, env });
  t.after(async () => {
    await second.close();
    await rm(fixture, { recursive: true, force: true });
  });
  await second.initialize();

  const result = await second.callTool("job_result", pending);

  assert.equal(result.status, "completed");
  assert.equal(result.final_message, "survived and finished");
  assert.equal(typeof result.duration_ms, "number");
});
test("a non-zero Worker exit mechanically records failed despite its output", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-failed-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "failing-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    [
      'process.stdout.write("SUCCESS marker is only Worker text");',
      "process.exitCode = 7;",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "failing-fake",
          capability_summary: "A scripted Worker that exits non-zero.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
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
    worker: "failing-fake",
    task_brief: "Exit non-zero.",
    working_dir: workingDir,
    wait_seconds: 15,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.final_message, "SUCCESS marker is only Worker text");
});
test("job_cancel terminates a running Worker and persists canceled", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-cancel-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "hanging-worker.mjs");
  const descendantPath = resolve(fixture, "descendant.mjs");
  const survivedPath = resolve(fixture, "descendant-survived.txt");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    descendantPath,
    [
      'import { writeFile } from "node:fs/promises";',
      "await new Promise((resolve) => setTimeout(resolve, 750));",
      'await writeFile(process.argv[2], "descendant survived");',
    ].join("\n"),
  );
  await writeFile(
    workerPath,
    [
      'import { spawn } from "node:child_process";',
      "spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: \"ignore\" });",
      'process.stdout.write("waiting for cancellation\\n");',
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "hanging-fake",
          capability_summary: "A scripted Worker that hangs.",
          command: process.execPath,
          args: [workerPath, descendantPath, survivedPath, "{task_brief}"],
          output_dialect: "plain",
        },
      ],
    }),
  );
  const env = {
    DIVISI_WORKERS_FILE: registryPath,
    LOCALAPPDATA: stateRoot,
    XDG_STATE_HOME: stateRoot,
  };
  const first = new McpClient({ cwd: repoRoot, env });
  let second;
  let running;
  t.after(async () => {
    if (running?.pid) {
      try {
        process.kill(running.pid);
      } catch {}
    }
    if (second) await second.close();
    await rm(fixture, { recursive: true, force: true });
  });
  await first.initialize();
  const pending = await first.callTool("delegate", {
    worker: "hanging-fake",
    task_brief: "Wait until canceled.",
    working_dir: workingDir,
    wait_seconds: 0,
  });
  running = await first.callTool("job_status", pending);
  await first.terminate();

  second = new McpClient({ cwd: repoRoot, env });
  await second.initialize();
  const canceled = await second.callTool("job_cancel", pending);
  const status = await second.callTool("job_status", pending);
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  assert.equal(canceled.status, "canceled");
  assert.equal(status.status, "canceled");
  assert.equal(status.alive, false);
  assert.match(canceled.final_message, /waiting for cancellation/);
  await assert.rejects(readFile(survivedPath, "utf8"));
});



test("canceling a worktree Delegation snapshots edits before returning", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-worktree-cancel-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "cancel-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  let worktreePath;
  let workerPid;
  await mkdir(workingDir);
  await writeFile(resolve(workingDir, "tracked.txt"), "baseline\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: workingDir });
  execFileSync("git", ["add", "tracked.txt"], { cwd: workingDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Divisi Test",
      "-c",
      "user.email=divisi@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: workingDir },
  );
  await writeFile(
    workerPath,
    [
      'import { writeFile } from "node:fs/promises";',
      'await writeFile("canceled-change.txt", "save me\\n");',
      'process.stdout.write("ready to cancel\\n");',
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "cancel-worktree-fake",
          capability_summary: "A Worker that edits before cancellation.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
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
    if (workerPid) {
      try {
        process.kill(workerPid);
      } catch {}
    }
    await client.close();
    if (worktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: workingDir,
        });
      } catch {}
    }
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();
  const pending = await client.callTool("delegate", {
    worker: "cancel-worktree-fake",
    task_brief: "Edit, then wait.",
    working_dir: workingDir,
    isolation: "worktree",
    wait_seconds: 0,
  });

  let running;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    running = await client.callTool("job_status", pending);
    if (running.recent_output.includes("ready to cancel")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  worktreePath = running.working_dir;
  workerPid = running.pid;

  const canceled = await client.callTool("job_cancel", pending);
  workerPid = undefined;

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.branch, running.branch);
  assert.match(canceled.git_diff_stat, /canceled-change\.txt/);
  assert.equal(
    execFileSync("git", ["show", `${canceled.branch}:canceled-change.txt`], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "save me\n",
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "",
  );
});


test("a worktree Snapshot completes after the originating server exits", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-worktree-detached-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "detached-worktree-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  let second;
  let worktreePath;
  await mkdir(workingDir);
  await writeFile(resolve(workingDir, "tracked.txt"), "baseline\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: workingDir });
  execFileSync("git", ["add", "tracked.txt"], { cwd: workingDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Divisi Test",
      "-c",
      "user.email=divisi@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: workingDir },
  );
  await writeFile(
    workerPath,
    [
      'import { writeFile } from "node:fs/promises";',
      "await new Promise((resolve) => setTimeout(resolve, 250));",
      'await writeFile("after-server-exit.txt", "controller preserved me\\n");',
      "process.stdout.write(process.cwd());",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "detached-worktree-fake",
          capability_summary: "A delayed worktree Worker.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
          output_dialect: "plain",
        },
      ],
    }),
  );
  const env = {
    DIVISI_WORKERS_FILE: registryPath,
    LOCALAPPDATA: stateRoot,
    XDG_STATE_HOME: stateRoot,
  };
  const first = new McpClient({ cwd: repoRoot, env });
  t.after(async () => {
    await first.close();
    if (second) await second.close();
    if (worktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: workingDir,
        });
      } catch {}
    }
    await rm(fixture, { recursive: true, force: true });
  });
  await first.initialize();
  const pending = await first.callTool("delegate", {
    worker: "detached-worktree-fake",
    task_brief: "Finish after this MCP session.",
    working_dir: workingDir,
    isolation: "worktree",
    wait_seconds: 0,
  });
  await first.close();

  second = new McpClient({ cwd: repoRoot, env });
  await second.initialize();
  let result = pending;
  for (let attempt = 0; attempt < 100 && !result.status; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await second.callTool("job_result", pending);
  }
  worktreePath = result.final_message;

  assert.equal(result.status, "completed");
  assert.match(result.branch, /^divisi\/[0-9a-f-]+$/);
  assert.match(result.git_diff_stat, /after-server-exit\.txt/);
  assert.equal(
    execFileSync("git", ["show", `${result.branch}:after-server-exit.txt`], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "controller preserved me\n",
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "",
  );
});


test("parallel worktree Delegations use distinct branches and directories", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-worktree-parallel-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "parallel-worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  const worktreePaths = [];
  await mkdir(workingDir);
  await writeFile(resolve(workingDir, "tracked.txt"), "baseline\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: workingDir });
  execFileSync("git", ["add", "tracked.txt"], { cwd: workingDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Divisi Test",
      "-c",
      "user.email=divisi@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: workingDir },
  );
  await writeFile(
    workerPath,
    [
      'import { writeFile } from "node:fs/promises";',
      "const name = process.argv[2];",
      'await new Promise((resolve) => setTimeout(resolve, 150));',
      'await writeFile(`${name}.txt`, `${name} branch\\n`);',
      "process.stdout.write(process.cwd());",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "parallel-worktree-fake",
          capability_summary: "A parallel worktree Worker.",
          command: process.execPath,
          args: [workerPath, "{task_brief}"],
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
    for (const path of worktreePaths) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", path], {
          cwd: workingDir,
        });
      } catch {}
    }
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();

  const pending = await Promise.all(
    ["alpha", "beta"].map((taskBrief) =>
      client.callTool("delegate", {
        worker: "parallel-worktree-fake",
        task_brief: taskBrief,
        working_dir: workingDir,
        isolation: "worktree",
        wait_seconds: 0,
      }),
    ),
  );
  const results = await Promise.all(
    pending.map(async (job) => {
      let result = job;
      for (let attempt = 0; attempt < 100 && !result.status; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        result = await client.callTool("job_result", job);
      }
      return result;
    }),
  );
  worktreePaths.push(...results.map((result) => result.final_message));

  assert.equal(new Set(results.map((result) => result.branch)).size, 2);
  assert.equal(new Set(worktreePaths).size, 2);
  assert.ok(
    worktreePaths.every((path) =>
      path.startsWith(`${resolve(stateRoot, "divisi", "worktrees")}${sep}`),
    ),
  );
  assert.equal(
    execFileSync("git", ["show", `${results[0].branch}:alpha.txt`], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "alpha branch\n",
  );
  assert.equal(
    execFileSync("git", ["show", `${results[1].branch}:beta.txt`], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "beta branch\n",
  );
  assert.throws(() =>
    execFileSync("git", ["show", `${results[0].branch}:beta.txt`], {
      cwd: workingDir,
      stdio: "ignore",
    }),
  );
  assert.throws(() =>
    execFileSync("git", ["show", `${results[1].branch}:alpha.txt`], {
      cwd: workingDir,
      stdio: "ignore",
    }),
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: workingDir,
      encoding: "utf8",
    }),
    "",
  );
});
async function startOptionWorker(
  t,
  { fixturePrefix, args, workerSource = "" },
) {
  const fixture = await mkdtemp(resolve(tmpdir(), fixturePrefix));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "worker.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(workerPath, workerSource);
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "fake",
          capability_summary: "A scripted Worker for option tests.",
          command: process.execPath,
          args: [workerPath, ...args],
          output_dialect: "plain",
          options: {
            effort: {
              values: ["low", "medium", "high"],
              flag: "--effort {value}",
              default: "high",
            },
          },
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
  return { client, stateRoot, workingDir };
}

test("delegate maps a declared Worker option onto the Worker CLI argv", async (t) => {
  const { client, workingDir } = await startOptionWorker(t, {
    fixturePrefix: "divisi-options-",
    args: ["{task_brief}", "{working_dir}"],
    workerSource:
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
  });

  const result = await client.callTool("delegate", {
    worker: "fake",
    task_brief: "Use medium effort.",
    working_dir: workingDir,
    options: { effort: "medium" },
    wait_seconds: 15,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(result.final_message), [
    "Use medium effort.",
    workingDir,
    "--effort",
    "medium",
  ]);
});

test("delegate applies a declared Worker option default when options are omitted", async (t) => {
  const { client, workingDir } = await startOptionWorker(t, {
    fixturePrefix: "divisi-option-default-",
    args: ["{task_brief}"],
    workerSource:
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
  });

  const result = await client.callTool("delegate", {
    worker: "fake",
    task_brief: "Use the default.",
    working_dir: workingDir,
    wait_seconds: 15,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(result.final_message), [
    "Use the default.",
    "--effort",
    "high",
  ]);
});

test("delegate rejects an option name the Worker registry does not declare", async (t) => {
  const { client, stateRoot, workingDir } = await startOptionWorker(t, {
    fixturePrefix: "divisi-unknown-option-",
    args: [],
  });

  await assert.rejects(
    client.callTool("delegate", {
      worker: "fake",
      task_brief: "Reject the unknown option.",
      working_dir: workingDir,
      options: { speed: "fast" },
      wait_seconds: 5,
    }),
    /Unknown Worker option: speed/,
  );
  await assert.rejects(readdir(resolve(stateRoot, "divisi", "jobs")));
});

test("delegate rejects a Worker option value outside the registry allowlist", async (t) => {
  const { client, stateRoot, workingDir } = await startOptionWorker(t, {
    fixturePrefix: "divisi-unknown-value-",
    args: [],
  });

  await assert.rejects(
    client.callTool("delegate", {
      worker: "fake",
      task_brief: "Reject the unknown value.",
      working_dir: workingDir,
      options: { effort: "maximum-overdrive" },
      wait_seconds: 5,
    }),
    /Unknown value for Worker option effort: maximum-overdrive/,
  );
  await assert.rejects(readdir(resolve(stateRoot, "divisi", "jobs")));
});


test("worktree isolation rejects a non-git working directory without launching", async (t) => {
  const { client, stateRoot, workingDir } = await startOptionWorker(t, {
    fixturePrefix: "divisi-worktree-non-git-",
    args: [],
  });

  await assert.rejects(
    client.callTool("delegate", {
      worker: "fake",
      task_brief: "Do not launch.",
      working_dir: workingDir,
      isolation: "worktree",
      wait_seconds: 5,
    }),
    /requires a git repository with a commit/,
  );
  await assert.rejects(readdir(resolve(stateRoot, "divisi", "jobs")));
});
