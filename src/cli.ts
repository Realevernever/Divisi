#!/usr/bin/env node

import { createInterface } from "node:readline";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupWorktree,
  createDelegationWorktree,
  gitChangeSummary,
  snapshotWorktree,
  type WorktreeJobFields,
} from "./worktree.js";
import { deepClean, retentionSweep } from "./cleanup.js";
import { replaceFileSync } from "./atomic-file.js";
import {
  parseCompletedOutput,
  readRecentOutput,
  type OutputDialect,
  type Usage,
} from "./output-dialect.js";
import { initCommand, snippetCommand } from "./installer.js";

const tools = [
  {
    name: "delegate",
    description: "Run a Delegation through a registered Worker CLI.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string" },
        task_brief: { type: "string" },
        working_dir: { type: "string" },
        isolation: {
          type: "string",
          enum: ["in_place", "worktree"],
        },
        options: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        wait_seconds: { type: "number", minimum: 0 },
      },
      required: ["worker", "task_brief", "working_dir", "wait_seconds"],
      additionalProperties: false,
    },
  },
  {
    name: "job_status",
    description: "Read the current mechanical status of a Delegation.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "job_result",
    description: "Read the mechanical result of a Delegation.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "job_list",
    description: "List Delegations recorded in the persistent Job store.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "job_cancel",
    description: "Cancel a running Delegation and its process group.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "job_cleanup",
    description:
      "Remove a finished Delegation worktree and safely retire its branch.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        discard: {
          type: "boolean",
          description: "Explicitly delete the unmerged job branch.",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_workers",
    description: "List the Workers available in the registry.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
};

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(
  id: string | number | null,
  code: number,
  message: string,
): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

type WorkerOption = {
  values: string[];
  flag?: string;
  env?: string;
  default: string;
};

type Worker = {
  id: string;
  capability_summary: string;
  command: string;
  args: string[];
  auth?: {
    mode: "vendor-managed";
    observed_env?: string[];
  };
  output_dialect: OutputDialect;
  required_env?: string[];
  version_args?: string[];
  options?: Record<string, WorkerOption>;
};

type ListedWorker = Pick<Worker, "id" | "capability_summary"> & {
  options: Record<string, Pick<WorkerOption, "values" | "default">>;
};

function toolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function listWorkers(): ListedWorker[] {
  return registryWorkers().map(({ id, capability_summary, options = {} }) => ({
    id,
    capability_summary,
    options: Object.fromEntries(
      Object.entries(options).map(([name, { values, default: defaultValue }]) => [
        name,
        { values, default: defaultValue },
      ]),
    ),
  }));
}

type JobResult = {
  status: "completed" | "failed" | "timeout" | "canceled";
  final_message: string;
  git_diff_stat: string;
  duration_ms: number;
  log_path: string;
  usage?: Usage;
  branch?: string;
};

function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

function registryWorkers(): Worker[] {
  const configured = process.env.DIVISI_WORKERS_FILE;
  const registryPath =
    configured && configured.length > 0
      ? configured
      : join(packageRoot(), "workers.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    workers: Worker[];
  };
  return registry.workers;
}

function executableOnPath(command: string): string | undefined {
  const hasDirectory = command.includes("/") || command.includes("\\");
  const directories = hasDirectory
    ? [""]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" && extname(command) === ""
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const directory of directories) {
    const base = hasDirectory
      ? isAbsolute(command)
        ? command
        : resolve(command)
      : join(directory, command);
    for (const extension of extensions) {
      const candidate = `${base}${extension.toLowerCase()}`;
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") {
          accessSync(candidate, constants.X_OK);
        }
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

function versionEnvironment(): NodeJS.ProcessEnv {
  const names =
    process.platform === "win32"
      ? ["PATH", "PATHEXT", "ComSpec", "SystemRoot", "WINDIR"]
      : ["PATH"];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function workerVersion(
  executable: string,
  versionArgs: string[],
): { output: string; healthy: boolean } {
  const options = {
    encoding: "utf8" as const,
    env: versionEnvironment(),
    windowsHide: true,
  };
  const result =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `call ${[executable, ...versionArgs]
              .map((part) => `"${part.replaceAll('"', '""')}"`)
              .join(" ")}`,
          ],
          { ...options, windowsVerbatimArguments: true },
        )
      : spawnSync(executable, versionArgs, options);
  const output = oneLine(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  return {
    output: output || "unavailable",
    healthy: result.status === 0 && output.length > 0,
  };
}

function doctor(): number {
  let allHealthy = true;
  for (const worker of registryWorkers()) {
    const executable = executableOnPath(worker.command);
    const version = executable
      ? workerVersion(executable, worker.version_args ?? ["--version"])
      : undefined;
    const auth = (worker.required_env ?? []).map((name) => ({
      name,
      set: Object.hasOwn(process.env, name),
    }));
    const observedAuth = (worker.auth?.observed_env ?? []).map((name) => ({
      name,
      set: Object.hasOwn(process.env, name),
    }));
    const healthy = version?.healthy === true && auth.every(({ set }) => set);
    allHealthy &&= healthy;
    const columns = [
      oneLine(worker.id),
      `cli=${executable ? "found" : "not-found"}`,
      ...(version ? [`version=${version.output}`] : []),
      ...(worker.auth ? [`auth=${worker.auth.mode}`] : []),
      ...observedAuth.map(
        ({ name, set }) => `${oneLine(name)}=${set ? "set" : "not-set"}`,
      ),
      ...auth.map(
        ({ name, set }) => `${oneLine(name)}=${set ? "set" : "not-set"}`,
      ),
    ];
    process.stdout.write(`${columns.join("\t")}\n`);
  }
  return allHealthy ? 0 : 1;
}


function userStateDirectory(): string {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "divisi",
    );
  }
  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "divisi",
  );
}

function writeJob(jobId: string, value: unknown): void {
  const jobsDirectory = join(userStateDirectory(), "jobs");
  mkdirSync(jobsDirectory, { recursive: true });
  const jobPath = join(jobsDirectory, `${jobId}.json`);
  const temporaryPath = join(
    jobsDirectory,
    `.${jobId}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(temporaryPath, JSON.stringify(value));
  replaceFileSync(temporaryPath, jobPath);
}

function listJobs(): unknown[] {
  const jobsDirectory = join(userStateDirectory(), "jobs");
  try {
    return readdirSync(jobsDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(jobsDirectory, name), "utf8")))
      .map((job) => publicJob(job as Record<string, unknown>));
  } catch {
    return [];
  }
}
function publicJob(job: Record<string, unknown>): Record<string, unknown> {
  const {
    launch: _launch,
    controller_pid: _controllerPid,
    cancel_requested_at: _cancelRequestedAt,
    output_dialect: _outputDialect,
    base_commit: _baseCommit,
    orchestrator_working_dir: _orchestratorWorkingDir,
    worktree_path: _worktreePath,
    ...visible
  } = job;
  return visible;
}



function readJob(jobId: string): Record<string, unknown> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      jobId,
    )
  ) {
    throw new Error("Refusing access for an invalid job id");
  }
  try {
    return JSON.parse(
      readFileSync(join(userStateDirectory(), "jobs", `${jobId}.json`), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new Error(`Unknown job: ${jobId}`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function jobStatus(jobId: string): Record<string, unknown> {
  const job = readJob(jobId);
  const logPath = String(job.log_path);
  const dialect = (job.output_dialect as OutputDialect | undefined) ?? "plain";
  const alive = job.status === "running" && isProcessAlive(Number(job.pid));
  return {
    ...publicJob(job),
    alive,
    recent_output: readRecentOutput(logPath, dialect),
  };
}
const terminalStatuses = new Set([
  "completed",
  "failed",
  "timeout",
  "canceled",
]);

function toJobResult(job: Record<string, unknown>): JobResult | undefined {
  if (!terminalStatuses.has(String(job.status))) return undefined;
  const result: JobResult = {
    status: job.status as JobResult["status"],
    final_message: String(job.final_message ?? ""),
    git_diff_stat: String(job.git_diff_stat ?? ""),
    duration_ms: Number(job.duration_ms ?? 0),
    log_path: String(job.log_path),
  };
  if (typeof job.branch === "string") result.branch = job.branch;
  if (typeof job.usage === "object" && job.usage !== null) {
    result.usage = job.usage as Usage;
  }
  return result;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


function gitDiffStat(workingDir: string): string {
  try {
    return execFileSync("git", ["diff", "--stat", "--no-ext-diff"], {
      cwd: workingDir,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}


function terminateWindowsTree(pid: number): void {
  execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

async function cancelJob(jobId: string): Promise<JobResult> {
  const job = readJob(jobId);
  const existingResult = toJobResult(job);
  if (existingResult) return existingResult;

  const requestedAt = new Date().toISOString();
  writeJob(jobId, { ...job, cancel_requested_at: requestedAt });
  const controllerPid = Number(job.controller_pid);
  const workerPid = Number(job.pid);
  try {
    if (process.platform === "win32") {
      terminateWindowsTree(controllerPid);
    } else {
      process.kill(-controllerPid, "SIGTERM");
    }
  } catch {
    if (isProcessAlive(controllerPid) || isProcessAlive(workerPid)) {
      throw new Error("Could not cancel job process group: " + jobId);
    }
  }

  const deadline = Date.now() + 2_000;
  while (
    Date.now() < deadline &&
    (isProcessAlive(controllerPid) || isProcessAlive(workerPid))
  ) {
    await sleep(20);
  }
  if (isProcessAlive(controllerPid) || isProcessAlive(workerPid)) {
    if (process.platform === "win32") {
      if (isProcessAlive(controllerPid)) terminateWindowsTree(controllerPid);
      if (isProcessAlive(workerPid)) terminateWindowsTree(workerPid);
    } else {
      process.kill(-controllerPid, "SIGKILL");
    }
  }
  if (isProcessAlive(controllerPid) || isProcessAlive(workerPid)) {
    throw new Error("Job process group survived cancellation: " + jobId);
  }

  const current = readJob(jobId);
  snapshotWorktree(current as unknown as WorktreeJobFields);
  const finishedAt = new Date();
  const { launch: _launch, ...persistent } = current;
  const parsedOutput = parseCompletedOutput(
    String(job.log_path),
    (job.output_dialect as OutputDialect | undefined) ?? "plain",
  );
  writeJob(jobId, {
    ...persistent,
    status: "canceled",
    exit_code: null,
    signal: process.platform === "win32" ? "taskkill" : "SIGTERM",
    finished_at: finishedAt.toISOString(),
    final_message: parsedOutput.finalMessage,
    ...(parsedOutput.usage && { usage: parsedOutput.usage }),
    git_diff_stat: gitChangeSummary(current as unknown as WorktreeJobFields),
    duration_ms: finishedAt.getTime() - Date.parse(String(job.started_at)),
  });
  return toJobResult(readJob(jobId)) as JobResult;
}

function cleanupJob(jobId: string, discard: boolean): unknown {
  const job = readJob(jobId);
  if (!terminalStatuses.has(String(job.status))) {
    throw new Error(`Refusing to clean running job: ${jobId}`);
  }
  return cleanupWorktree(
    job as unknown as WorktreeJobFields,
    userStateDirectory(),
    discard,
  );
}

async function startDelegation(
  workerId: string,
  taskBrief: string,
  workingDir: string,
  requestedOptions: Record<string, string>,
  requestedIsolation: string,
): Promise<{ jobId: string }> {
  const worker = registryWorkers().find(({ id }) => id === workerId);
  if (!worker) throw new Error(`Unknown Worker: ${workerId}`);
  if (
    worker.output_dialect !== "plain" &&
    worker.output_dialect !== "jsonl-events"
  ) {
    throw new Error(`Unsupported Output dialect: ${worker.output_dialect}`);
  }
  const declaredOptions = worker.options ?? {};
  for (const name of Object.keys(requestedOptions)) {
    if (!Object.hasOwn(declaredOptions, name))
      throw new Error(`Unknown Worker option: ${name}`);
  }
  const optionArgs: string[] = [];
  const optionEnv: Record<string, string> = {};
  for (const [name, option] of Object.entries(declaredOptions)) {
    const value = requestedOptions[name] ?? option.default;
    if (!option.values.includes(value))
      throw new Error(`Unknown value for Worker option ${name}: ${value}`);
    if (option.flag) {
      optionArgs.push(
        ...option.flag
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((arg) => arg.replaceAll("{value}", value)),
      );
    }
    if (option.env) {
      const envName = option.env.trim();
      if (!envName) throw new Error(`Empty env name for Worker option ${name}`);
      optionEnv[envName] = value;
    }
    if (!option.flag && !option.env) {
      throw new Error(
        `Worker option ${name} must declare flag and/or env mapping`,
      );
    }
  }
  if (requestedIsolation !== "in_place" && requestedIsolation !== "worktree") {
    throw new Error(`Unknown isolation: ${requestedIsolation}`);
  }

  const jobId = randomUUID();
  const worktree =
    requestedIsolation === "worktree"
      ? createDelegationWorktree(workingDir, jobId, userStateDirectory())
      : undefined;
  const delegationWorkingDir = worktree?.workingDir ?? resolve(workingDir);
  const args = [
    ...worker.args.map((arg) =>
      arg
        .replaceAll("{task_brief}", taskBrief)
        .replaceAll("{working_dir}", delegationWorkingDir),
    ),
    ...optionArgs,
  ];
  const logsDirectory = join(userStateDirectory(), "logs");
  mkdirSync(logsDirectory, { recursive: true });
  const logPath = join(logsDirectory, `${jobId}.log`);
  writeFileSync(logPath, "");
  const createdAt = new Date().toISOString();
  writeJob(jobId, {
    job_id: jobId,
    worker: workerId,
    status: "starting",
    pid: null,
    controller_pid: null,
    working_dir: delegationWorkingDir,
    ...(worktree && {
      isolation: "worktree",
      branch: worktree.branch,
      base_commit: worktree.baseCommit,
      orchestrator_working_dir: worktree.repoRoot,
      worktree_path: worktree.worktreePath,
    }),
    task_brief: taskBrief,
    created_at: createdAt,
    started_at: createdAt,
    log_path: logPath,
    output_dialect: worker.output_dialect,
    launch: {
      command: worker.command,
      args,
      ...(Object.keys(optionEnv).length > 0 && { env: optionEnv }),
    },
  });

  const jobPath = join(userStateDirectory(), "jobs", `${jobId}.json`);
  const runnerPath = fileURLToPath(new URL("./job-runner.js", import.meta.url));
  let controllerAttempts = 0;
  let controllerStderr = "";
  const launchController = () => {
    controllerAttempts += 1;
    controllerStderr = "";
    const launched = spawn(process.execPath, [runnerPath, jobPath], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    launched.stderr?.setEncoding("utf8");
    launched.stderr?.on("data", (chunk: string) => {
      controllerStderr = `${controllerStderr}${chunk}`.slice(-4_096);
    });
    launched.unref();
    return launched;
  };
  let controller = launchController();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = readJob(jobId);
    if (job.status !== "starting" && job.status !== "launching") {
      controller.stderr?.destroy();
      return { jobId };
    }
    if (controller.exitCode !== null) {
      const settledJob = readJob(jobId);
      if (
        settledJob.status !== "starting" &&
        settledJob.status !== "launching"
      ) {
        controller.stderr?.destroy();
        return { jobId };
      }
      if (settledJob.status === "starting" && controllerAttempts < 3) {
        await sleep(25 * controllerAttempts);
        controller = launchController();
        continue;
      }
      throw new Error(
        `Job controller exited before starting Worker: ${jobId} (exit ${controller.exitCode}): ${controllerStderr
          .trim()
          .replace(/\s+/g, " ") || "no controller diagnostic"}`,
      );
    }
    await sleep(10);
  }
  controller.stderr?.destroy();
  throw new Error(`Timed out starting Worker: ${jobId}`);
}

async function waitForResult(
  jobId: string,
  waitSeconds: number,
): Promise<JobResult | undefined> {
  if (waitSeconds <= 0) return undefined;
  const deadline = Date.now() + waitSeconds * 1_000;
  do {
    const result = toJobResult(readJob(jobId));
    if (result) return result;
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return toJobResult(readJob(jobId));
}
function serve(): void {
  retentionSweep(userStateDirectory());
  const input = createInterface({ input: process.stdin });
  input.on("close", () => {
    process.exit(0);
  });
  input.on("line", async (line) => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      respondError(null, -32700, "Parse error");
      return;
    }

    if (request.id === undefined) return;

    if (request.method === "initialize") {
      respond(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "divisi", version: "0.1.0" },
      });
      return;
    }

    if (request.method === "tools/list") {
      respond(request.id, { tools });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params as { name?: string };
      const requestId = request.id as string | number;
      if (params.name === "delegate") {
        try {
          const args = (request.params as { arguments?: Record<string, unknown> })
            .arguments ?? {};
          const { jobId } = await startDelegation(
            String(args.worker),
            String(args.task_brief),
            String(args.working_dir),
            (args.options ?? {}) as Record<string, string>,
            args.isolation === undefined
              ? "in_place"
              : String(args.isolation),
          );
          const result = await waitForResult(
            jobId,
            Number(args.wait_seconds),
          );
          respond(requestId, toolResult(result ?? { job_id: jobId }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond(requestId, {
            isError: true,
            ...toolResult({ error: message }),
          });
        }
        return;
      }
      if (params.name === "job_status") {
        const args = (request.params as { arguments?: Record<string, unknown> })
          .arguments ?? {};
        try {
          respond(requestId, toolResult(jobStatus(String(args.job_id))));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond(requestId, {
            isError: true,
            ...toolResult({ error: message }),
          });
        }
        return;
      }
      if (params.name === "job_result") {
        const args = (request.params as { arguments?: Record<string, unknown> })
          .arguments ?? {};
        const jobId = String(args.job_id);
        try {
          const result = toJobResult(readJob(jobId));
          respond(
            requestId,
            toolResult(result ?? { job_id: jobId }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond(requestId, {
            isError: true,
            ...toolResult({ error: message }),
          });
        }
        return;
      }
      if (params.name === "job_cancel") {
        const args = (request.params as { arguments?: Record<string, unknown> })
          .arguments ?? {};
        try {
          respond(requestId, toolResult(await cancelJob(String(args.job_id))));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond(requestId, {
            isError: true,
            ...toolResult({ error: message }),
          });
        }
        return;
      }
      if (params.name === "job_cleanup") {
        const args = (request.params as { arguments?: Record<string, unknown> })
          .arguments ?? {};
        try {
          respond(
            requestId,
            toolResult(cleanupJob(String(args.job_id), args.discard === true)),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond(requestId, {
            isError: true,
            ...toolResult({ error: message }),
          });
        }
        return;
      }
      if (params.name === "job_list") {
        respond(requestId, toolResult(listJobs()));
        return;
      }
      if (params.name === "list_workers") {
        try {
          respond(requestId, toolResult(listWorkers()));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond(requestId, {
            isError: true,
            ...toolResult({ error: message }),
          });
        }
        return;
      }
    }

    respondError(request.id, -32601, "Method not found");
  });
}

async function cleanCommand(args: string[]): Promise<number> {
  const allowed = new Set(["--yes", "--drop-unmerged"]);
  const unknown = args.find((arg) => !allowed.has(arg));
  if (unknown) {
    process.stderr.write(`Unknown clean option: ${unknown}\n`);
    return 1;
  }
  const dropUnmerged = args.includes("--drop-unmerged");
  let confirmed = args.includes("--yes");
  const stateDirectory = userStateDirectory();
  const items = deepClean(stateDirectory, {
    apply: false,
    dropUnmerged,
  });
  if (items.length === 0) {
    process.stdout.write("No reclaimable items.\n");
  } else {
    process.stdout.write(`${items.join("\n")}\n`);
  }

  if (!confirmed && process.stdin.isTTY) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await new Promise<string>((resolveAnswer) => {
        prompt.question("Apply safe cleanup? [y/N] ", resolveAnswer);
      });
      confirmed = /^(?:y|yes)$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  } else if (!confirmed) {
    process.stdout.write("Apply safe cleanup? [y/N] ");
    const answer = readFileSync(0, "utf8");
    confirmed = /^(?:y|yes)$/i.test(answer.trim());
    process.stdout.write("\n");
  }
  if (!confirmed) {
    process.stdout.write(
      "Dry run: no changes made. Pass --yes to confirm cleanup.\n",
    );
    return 0;
  }

  try {
    deepClean(stateDirectory, {
      apply: true,
      dropUnmerged,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Cleanup refused: ${message}\n`);
    return 1;
  }
  process.stdout.write(
    dropUnmerged
      ? "Cleanup complete; unmerged branches were explicitly eligible.\n"
      : "Cleanup complete; unmerged branches were preserved.\n",
  );
  return 0;
}

if (process.argv[2] === "serve") {
  try {
    serve();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not start Divisi: ${message}\n`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "doctor") {
  process.exitCode = doctor();
} else if (process.argv[2] === "clean") {
  cleanCommand(process.argv.slice(3)).then((code) => {
    process.exitCode = code;
  });
} else if (process.argv[2] === "init") {
  initCommand(process.argv.slice(3))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not initialize Divisi: ${message}\n`);
      process.exitCode = 1;
    });
} else if (process.argv[2] === "snippet") {
  try {
    process.exitCode = snippetCommand(process.argv.slice(3));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not apply Divisi snippet: ${message}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write("Usage: divisi <serve|init|snippet|doctor|clean>\n");
  process.exitCode = 1;
}
