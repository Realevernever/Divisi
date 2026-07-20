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
    ["delegate", "job_result", "list_workers"],
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
