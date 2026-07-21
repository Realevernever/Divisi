import { spawn } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  gitChangeSummary,
  snapshotWorktree,
  type WorktreeJobFields,
} from "./worktree.js";
import { replaceFileSync } from "./atomic-file.js";
import {
  parseCompletedOutput,
  type OutputDialect,
  type Usage,
} from "./output-dialect.js";

type LaunchRecord = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type JobRecord = WorktreeJobFields & {
  worker: string;
  output_dialect?: OutputDialect;
  status:
    | "starting"
    | "launching"
    | "running"
    | "completed"
    | "failed"
    | "timeout"
    | "canceled";
  pid: number | null;
  controller_pid: number | null;
  task_brief: string;
  created_at: string;
  started_at: string;
  finished_at?: string;
  log_path: string;
  cancel_requested_at?: string;
  launch?: LaunchRecord;
  exit_code?: number | null;
  signal?: string | null;
  final_message?: string;
  git_diff_stat?: string;
  usage?: Usage;
  duration_ms?: number;
};

const jobPathArgument = process.argv[2];
if (!jobPathArgument) throw new Error("Job record path is required");
const jobPath: string = jobPathArgument;

function readJob(): JobRecord {
  return JSON.parse(readFileSync(jobPath, "utf8")) as JobRecord;
}

function writeJob(job: JobRecord): void {
  const temporaryPath = join(
    dirname(jobPath),
    `.${job.job_id}.${process.pid}.tmp`,
  );
  writeFileSync(temporaryPath, JSON.stringify(job));
  replaceFileSync(temporaryPath, jobPath);
}


function finish(
  running: JobRecord,
  status: "completed" | "failed",
  exitCode: number | null,
  signal: string | null,
): void {
  const current = readJob();
  if (
    current.status === "canceled" ||
    current.status === "timeout" ||
    current.cancel_requested_at
  ) return;
  snapshotWorktree(running);
  const finishedAt = new Date();
  const { launch: _launch, ...publicRecord } = running;
  const parsedOutput = parseCompletedOutput(
    running.log_path,
    running.output_dialect ?? "plain",
  );
  writeJob({
    ...publicRecord,
    status,
    exit_code: exitCode,
    signal,
    finished_at: finishedAt.toISOString(),
    final_message: parsedOutput.finalMessage,
    ...(parsedOutput.usage && { usage: parsedOutput.usage }),
    git_diff_stat: gitChangeSummary(running),
    duration_ms: finishedAt.getTime() - Date.parse(running.started_at),
  });
}

const initial = readJob();
const launch = initial.launch;
if (!launch) throw new Error("Job launch record is missing");
const claimed: JobRecord = {
  ...initial,
  status: "launching",
  controller_pid: process.pid,
};
writeJob(claimed);
const logFile = openSync(claimed.log_path, "a");
let child;
try {
  child = spawn(launch.command, launch.args, {
    cwd: claimed.working_dir,
    windowsHide: true,
    stdio: ["ignore", logFile, logFile],
    ...(launch.env && {
      env: {
        ...process.env,
        ...launch.env,
      },
    }),
  });
} catch {
  closeSync(logFile);
  finish(claimed, "failed", null, null);
  process.exit(1);
}
closeSync(logFile);

const running: JobRecord = {
  ...claimed,
  status: "running",
  pid: child.pid ?? null,
  controller_pid: process.pid,
  started_at: new Date().toISOString(),
};
writeJob(running);

let settled = false;
child.once("error", () => {
  if (settled) return;
  settled = true;
  finish(running, "failed", null, null);
});
child.once("close", (code, signal) => {
  if (settled) return;
  settled = true;
  finish(running, code === 0 ? "completed" : "failed", code, signal);
});
