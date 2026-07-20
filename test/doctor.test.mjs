import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpClient } from "./support/mcp-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function writeWorkerCli(binDirectory, name, source) {
  if (process.platform === "win32") {
    const path = resolve(binDirectory, `${name}.cmd`);
    await writeFile(path, `@echo off\r\n${source.replaceAll("\n", "\r\n")}\r\n`);
    return;
  }

  const path = resolve(binDirectory, name);
  await writeFile(path, `#!/bin/sh\n${source}\n`);
  await chmod(path, 0o755);
}

function runDoctor({ binDirectory, registryPath, env = {} }) {
  const platformEnv =
    process.platform === "win32"
      ? {
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        }
      : {};
  return spawnSync(
    process.execPath,
    [resolve(repoRoot, "dist", "cli.js"), "doctor"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...platformEnv,
        PATH: binDirectory,
        DIVISI_WORKERS_FILE: registryPath,
        ...env,
      },
    },
  );
}

test("doctor reports health without exposing auth or creating logs", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-doctor-healthy-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const binDirectory = resolve(fixture, "bin");
  const registryPath = resolve(fixture, "workers.json");
  const stateRoot = resolve(fixture, "state");
  await mkdir(binDirectory);
  await writeWorkerCli(
    binDirectory,
    "healthy-worker",
    process.platform === "win32"
      ? [
          "if defined DIVISI_DOCTOR_TOKEN echo LEAK:%DIVISI_DOCTOR_TOKEN%",
          "echo healthy-worker 9.8.7",
        ].join("\n")
      : [
          'if [ -n "${DIVISI_DOCTOR_TOKEN+x}" ]; then printf \'LEAK:%s\\n\' "$DIVISI_DOCTOR_TOKEN"; fi',
          "printf 'healthy-worker 9.8.7\\n'",
        ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "healthy",
          capability_summary: "A healthy scripted Worker.",
          command: "healthy-worker",
          args: ["{task_brief}"],
          output_dialect: "plain",
          required_env: ["DIVISI_DOCTOR_TOKEN"],
        },
      ],
    }),
  );
  const secret = "crown-jewel-secret-value";

  const result = runDoctor({
    binDirectory,
    registryPath,
    env: {
      DIVISI_DOCTOR_TOKEN: secret,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });

  assert.equal(
    result.status,
    0,
    JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    }),
  );
  assert.equal(
    result.stdout,
    "healthy\tcli=found\tversion=healthy-worker 9.8.7\tDIVISI_DOCTOR_TOKEN=set\n",
  );
  assert.equal(result.stderr, "");
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  await assert.rejects(readdir(resolve(stateRoot, "divisi")));
});

test("doctor prints one row per Worker and fails when any probe fails", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-doctor-failures-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const binDirectory = resolve(fixture, "bin");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(binDirectory);
  await writeWorkerCli(
    binDirectory,
    "custom-version-worker",
    process.platform === "win32"
      ? [
          'if "%~1"=="version" echo custom-version-worker 1.2.3',
          'if "%~1"=="version" exit /b 0',
          "exit /b 2",
        ].join("\n")
      : [
          'if [ "$1" = "version" ]; then',
          "  printf 'custom-version-worker 1.2.3\\n'",
          "  exit 0",
          "fi",
          "exit 2",
        ].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "auth-missing",
          capability_summary: "A Worker with incomplete auth.",
          command: "custom-version-worker",
          args: ["{task_brief}"],
          output_dialect: "plain",
          required_env: ["DIVISI_SET_TOKEN", "DIVISI_MISSING_TOKEN"],
          version_args: ["version"],
        },
        {
          id: "unavailable",
          capability_summary: "A missing Worker.",
          command: "missing-worker",
          args: ["{task_brief}"],
          output_dialect: "plain",
          required_env: ["DIVISI_UNAVAILABLE_TOKEN"],
        },
      ],
    }),
  );

  const result = runDoctor({
    binDirectory,
    registryPath,
    env: { DIVISI_SET_TOKEN: "another-secret-value" },
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    [
      "auth-missing\tcli=found\tversion=custom-version-worker 1.2.3\tDIVISI_SET_TOKEN=set\tDIVISI_MISSING_TOKEN=not-set",
      "unavailable\tcli=not-found\tDIVISI_UNAVAILABLE_TOKEN=not-set",
      "",
    ].join("\n"),
  );
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 2);
  assert.equal(result.stdout.includes("another-secret-value"), false);
});

test("a Worker failing every doctor probe can still be delegated to", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-doctor-advisory-"));
  const binDirectory = resolve(fixture, "bin");
  const workingDir = resolve(fixture, "repo");
  const stateRoot = resolve(fixture, "state");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(binDirectory);
  await mkdir(workingDir);
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "all-probes-fail",
          capability_summary: "A Worker unavailable to doctor.",
          command: "definitely-missing-worker",
          args: ["{task_brief}"],
          output_dialect: "plain",
          required_env: ["DIVISI_ABSENT_TOKEN"],
        },
      ],
    }),
  );

  const doctor = runDoctor({ binDirectory, registryPath });
  assert.equal(doctor.status, 1);
  assert.equal(
    doctor.stdout,
    "all-probes-fail\tcli=not-found\tDIVISI_ABSENT_TOKEN=not-set\n",
  );

  const client = new McpClient({
    cwd: repoRoot,
    env: {
      DIVISI_WORKERS_FILE: registryPath,
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
      PATH: binDirectory,
    },
  });
  t.after(async () => {
    await client.close();
    await rm(fixture, { recursive: true, force: true });
  });
  await client.initialize();

  const pending = await client.callTool("delegate", {
    worker: "all-probes-fail",
    task_brief: "Attempt this despite doctor.",
    working_dir: workingDir,
    wait_seconds: 0,
  });
  assert.equal(typeof pending.job_id, "string");

  let result = pending;
  for (let attempt = 0; attempt < 100 && !result.status; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    result = await client.callTool("job_result", pending);
  }

  assert.equal(result.status, "failed");
  assert.equal(typeof result.duration_ms, "number");
  assert.equal(await readFile(result.log_path, "utf8"), result.final_message);
});

test("doctor fails when a found Worker's version probe fails", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-doctor-version-fail-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const binDirectory = resolve(fixture, "bin");
  const registryPath = resolve(fixture, "workers.json");
  await mkdir(binDirectory);
  await writeWorkerCli(
    binDirectory,
    "broken-version-worker",
    process.platform === "win32"
      ? [">&2 echo version probe failed", "exit /b 23"].join("\n")
      : [">&2 printf 'version probe failed\\n'", "exit 23"].join("\n"),
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      workers: [
        {
          id: "broken-version",
          capability_summary: "A Worker with a failing version command.",
          command: "broken-version-worker",
          args: ["{task_brief}"],
          output_dialect: "plain",
        },
      ],
    }),
  );

  const result = runDoctor({ binDirectory, registryPath });

  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    "broken-version\tcli=found\tversion=version probe failed\n",
  );
  assert.equal(result.stderr, "");
});
