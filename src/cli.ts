#!/usr/bin/env node

import { createInterface } from "node:readline";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const tools = [
  {
    name: "delegate",
    description: "Run an in-place Delegation through a registered Worker CLI.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string" },
        task_brief: { type: "string" },
        working_dir: { type: "string" },
        wait_seconds: { type: "number", minimum: 0 },
      },
      required: ["worker", "task_brief", "working_dir", "wait_seconds"],
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

type Worker = {
  id: string;
  capability_summary: string;
  command: string;
  args: string[];
  output_dialect: "plain";
};

function toolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function listWorkers(): Array<Pick<Worker, "id" | "capability_summary">> {
  return registryWorkers().map(({ id, capability_summary }) => ({
    id,
    capability_summary,
  }));
}

type JobResult = {
  status: "completed" | "failed";
  final_message: string;
  git_diff_stat: string;
  duration_ms: number;
  log_path: string;
};

const activeJobs = new Map<string, Promise<JobResult>>();
const completedJobs = new Map<string, JobResult>();

function registryWorkers(): Worker[] {
  const registryPath = process.env.DIVISI_WORKERS_FILE;
  if (!registryPath) throw new Error("DIVISI_WORKERS_FILE is not set");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    workers: Worker[];
  };
  return registry.workers;
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
  writeFileSync(join(jobsDirectory, `${jobId}.json`), JSON.stringify(value));
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

function startDelegation(
  workerId: string,
  taskBrief: string,
  workingDir: string,
): { jobId: string; completion: Promise<JobResult> } {
  const worker = registryWorkers().find(({ id }) => id === workerId);
  if (!worker) throw new Error(`Unknown Worker: ${workerId}`);
  if (worker.output_dialect !== "plain") {
    throw new Error(`Unsupported Output dialect: ${worker.output_dialect}`);
  }

  const jobId = randomUUID();
  const logsDirectory = join(userStateDirectory(), "logs");
  mkdirSync(logsDirectory, { recursive: true });
  const logPath = join(logsDirectory, `${jobId}.log`);
  const logFile = openSync(logPath, "w");
  const startedAt = Date.now();
  const args = worker.args.map((arg) =>
    arg
      .replaceAll("{task_brief}", taskBrief)
      .replaceAll("{working_dir}", workingDir),
  );
  let child;
  try {
    child = spawn(worker.command, args, {
      cwd: workingDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFile, logFile],
    });
  } finally {
    closeSync(logFile);
  }
  child.unref();
  writeJob(jobId, {
    job_id: jobId,
    status: "running",
    pid: child.pid,
    working_dir: workingDir,
    log_path: logPath,
  });

  const completion = new Promise<JobResult>((resolve) => {
    let settled = false;
    const finish = (status: "completed" | "failed"): void => {
      if (settled) return;
      settled = true;
      const result: JobResult = {
        status,
        final_message: readFileSync(logPath, "utf8"),
        git_diff_stat: gitDiffStat(workingDir),
        duration_ms: Date.now() - startedAt,
        log_path: logPath,
      };
      completedJobs.set(jobId, result);
      activeJobs.delete(jobId);
      writeJob(jobId, result);
      resolve(result);
    };
    child.once("error", () => finish("failed"));
    child.once("close", (code) => finish(code === 0 ? "completed" : "failed"));
  });
  activeJobs.set(jobId, completion);
  return { jobId, completion };
}

async function waitForResult(
  completion: Promise<JobResult>,
  waitSeconds: number,
): Promise<JobResult | undefined> {
  if (waitSeconds <= 0) return undefined;
  let timer: number | NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, waitSeconds * 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serve(): void {
  const input = createInterface({ input: process.stdin });
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
          const { jobId, completion } = startDelegation(
            String(args.worker),
            String(args.task_brief),
            String(args.working_dir),
          );
          const result = await waitForResult(
            completion,
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
      if (params.name === "job_result") {
        const args = (request.params as { arguments?: Record<string, unknown> })
          .arguments ?? {};
        const jobId = String(args.job_id);
        const result = completedJobs.get(jobId);
        if (result) {
          respond(requestId, toolResult(result));
        } else if (activeJobs.has(jobId)) {
          respond(requestId, toolResult({ job_id: jobId }));
        } else {
          respond(requestId, {
            isError: true,
            ...toolResult({ error: `Unknown job: ${jobId}` }),
          });
        }
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

if (process.argv[2] === "serve") {
  serve();
} else {
  process.stderr.write("Usage: divisi serve\n");
  process.exitCode = 1;
}
