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
});

test("list_workers reports registry ids and capability summaries", async (t) => {
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
    },
  ]);
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
    wait_seconds: 5,
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
  await first.terminate();

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
    wait_seconds: 5,
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
