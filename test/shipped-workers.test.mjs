import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpClient } from "./support/mcp-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shippedRegistryPath = resolve(repoRoot, "workers.json");

async function registryFromShipped(workerId, command, args) {
  const shipped = JSON.parse(await readFile(shippedRegistryPath, "utf8"));
  const worker = shipped.workers.find((entry) => entry.id === workerId);
  assert.ok(worker, `missing shipped worker ${workerId}`);
  return {
    workers: [
      {
        ...worker,
        command,
        args,
      },
    ],
  };
}

test("list_workers uses the shipped registry when DIVISI_WORKERS_FILE is unset", async (t) => {
  const client = new McpClient({
    cwd: repoRoot,
    env: { DIVISI_WORKERS_FILE: "" },
  });
  t.after(() => client.close());
  await client.initialize();

  const workers = await client.callTool("list_workers");
  assert.deepEqual(
    workers.map((worker) => worker.id).sort(),
    ["grok-4.5", "kimi-k3"],
  );
});

test("list_workers exposes the shipped Grok 4.5 Worker with high effort default", async (t) => {
  const client = new McpClient({
    cwd: repoRoot,
    env: { DIVISI_WORKERS_FILE: shippedRegistryPath },
  });
  t.after(() => client.close());
  await client.initialize();

  const workers = await client.callTool("list_workers");
  const grok = workers.find((worker) => worker.id === "grok-4.5");

  assert.ok(grok, "expected shipped Worker id grok-4.5");
  assert.equal(typeof grok.capability_summary, "string");
  assert.ok(grok.capability_summary.length > 0);
  assert.deepEqual(grok.options.effort, {
    values: ["low", "medium", "high"],
    default: "high",
  });
  assert.equal(Object.hasOwn(grok.options.effort, "flag"), false);
});

test("list_workers exposes the shipped Kimi K3 Worker with max effort default", async (t) => {
  const client = new McpClient({
    cwd: repoRoot,
    env: { DIVISI_WORKERS_FILE: shippedRegistryPath },
  });
  t.after(() => client.close());
  await client.initialize();

  const workers = await client.callTool("list_workers");
  const kimi = workers.find((worker) => worker.id === "kimi-k3");

  assert.ok(kimi, "expected shipped Worker id kimi-k3");
  assert.equal(typeof kimi.capability_summary, "string");
  assert.ok(kimi.capability_summary.length > 0);
  assert.deepEqual(kimi.options.effort, {
    values: ["low", "high", "max"],
    default: "max",
  });
  assert.equal(Object.hasOwn(kimi.options.effort, "flag"), false);
});

test("list_workers keeps shipped invocation and auth syntax registry-owned", async (t) => {
  const client = new McpClient({
    cwd: repoRoot,
    env: { DIVISI_WORKERS_FILE: shippedRegistryPath },
  });
  t.after(() => client.close());
  await client.initialize();

  const workers = await client.callTool("list_workers");
  const summaries = workers.map(({ capability_summary }) => capability_summary);
  const operationalSyntax = [
    "--output-format",
    "--effort",
    "--yolo",
    "KIMI_MODEL_THINKING_EFFORT",
    "KIMI_API_KEY",
    "XAI_API_KEY",
  ];

  for (const summary of summaries) {
    for (const syntax of operationalSyntax) {
      assert.equal(summary.includes(syntax), false, `${syntax} leaked from registry`);
    }
  }
});
test("shipped Grok effort default maps onto the Worker CLI argv", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-shipped-grok-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "echo-argv.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
  );
  await writeFile(
    registryPath,
    JSON.stringify(
      await registryFromShipped("grok-4.5", process.execPath, [
        workerPath,
        "{task_brief}",
      ]),
    ),
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
    worker: "grok-4.5",
    task_brief: "echo argv only",
    working_dir: workingDir,
    wait_seconds: 15,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(result.final_message), [
    "echo argv only",
    "--effort",
    "high",
  ]);
});

test("shipped Kimi effort default maps onto the Worker process env", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-shipped-kimi-"));
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const workerPath = resolve(fixture, "echo-env.mjs");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(workingDir);
  await writeFile(
    workerPath,
    [
      "process.stdout.write(",
      "  JSON.stringify({",
      "    argv: process.argv.slice(2),",
      "    effort: process.env.KIMI_MODEL_THINKING_EFFORT ?? null,",
      "  }),",
      ");",
    ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify(
      await registryFromShipped("kimi-k3", process.execPath, [
        workerPath,
        "{task_brief}",
      ]),
    ),
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
    worker: "kimi-k3",
    task_brief: "echo env only",
    working_dir: workingDir,
    wait_seconds: 15,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(result.final_message), {
    argv: ["echo env only"],
    effort: "max",
  });
});

test("doctor accepts vendor-managed auth without requiring shell credentials", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-shipped-doctor-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const binDirectory = resolve(fixture, "bin");
  await mkdir(binDirectory);
  if (process.platform === "win32") {
    await writeFile(
      resolve(binDirectory, "grok.cmd"),
      "@echo off\r\necho grok 0.0.0-test\r\n",
    );
    await writeFile(
      resolve(binDirectory, "kimi.cmd"),
      "@echo off\r\necho 0.0.0-test\r\n",
    );
  } else {
    await writeFile(resolve(binDirectory, "grok"), "#!/bin/sh\nprintf 'grok 0.0.0-test\\n'\n");
    await writeFile(resolve(binDirectory, "kimi"), "#!/bin/sh\nprintf '0.0.0-test\\n'\n");
    await chmod(resolve(binDirectory, "grok"), 0o755);
    await chmod(resolve(binDirectory, "kimi"), 0o755);
  }

  const platformEnv =
    process.platform === "win32"
      ? {
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        }
      : {};
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "dist", "cli.js"), "doctor"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...platformEnv,
        PATH: binDirectory,
        DIVISI_WORKERS_FILE: shippedRegistryPath,
      },
    },
  );

  assert.equal(result.status, 0, JSON.stringify({
    stdout: result.stdout,
    stderr: result.stderr,
  }));
  assert.match(
    result.stdout,
    /^grok-4\.5\tcli=found\tversion=.+\tauth=vendor-managed\tXAI_API_KEY=not-set$/m,
  );
  assert.match(
    result.stdout,
    /^kimi-k3\tcli=found\tversion=.+\tauth=vendor-managed$/m,
  );
});
