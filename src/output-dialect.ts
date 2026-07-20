import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";

import { StringDecoder } from "node:string_decoder";
export type OutputDialect = "plain" | "jsonl-events";
export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
};

export type ParsedOutput = {
  finalMessage: string;
  usage?: Usage;
};

type MessageEvent = {
  type: "message";
  message: string;
  terminal: true;
};

function terminalMessage(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<MessageEvent>).type !== "message" ||
    (value as Partial<MessageEvent>).terminal !== true ||
    typeof (value as Partial<MessageEvent>).message !== "string"
  ) {
    return undefined;
  }
  return (value as MessageEvent).message;
}

function usageEvent(line: string): Usage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).type !== "usage"
  ) {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  const usage = Object.fromEntries(
    ["input_tokens", "output_tokens", "total_tokens", "cost_usd"]
      .flatMap((key) => {
        const fact = event[key];
        const valid =
          typeof fact === "number" &&
          Number.isFinite(fact) &&
          fact >= 0 &&
          (key === "cost_usd" || Number.isInteger(fact));
        return valid ? [[key, fact]] : [];
      }),
  ) as Usage;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function forEachJsonlLine(logPath: string, visit: (line: string) => void): void {
  const handle = openSync(logPath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    let bytesRead: number;
    do {
      bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        visit(line.endsWith("\r") ? line.slice(0, -1) : line);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    } while (bytesRead > 0);
    pending += decoder.end();
    if (pending.length > 0) visit(pending);
  } finally {
    closeSync(handle);
  }
}

export function parseCompletedOutput(
  logPath: string,
  dialect: OutputDialect,
): ParsedOutput {
  if (dialect === "plain") {
    return { finalMessage: readFileSync(logPath, "utf8") };
  }
  let finalMessage = "";
  let usage: Usage | undefined;
  forEachJsonlLine(logPath, (line) => {
    const eventUsage = usageEvent(line);
    if (eventUsage) {
      usage = { ...usage, ...eventUsage };
    }
    const message = terminalMessage(line);
    if (message !== undefined) {
      finalMessage = message;
    }
  });
  return {
    finalMessage,
    ...(usage && { usage }),
  };
}

function isRecentEvent(line: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  if (event.type === "progress") return typeof event.message === "string";
  if (event.type === "message") {
    return (
      typeof event.message === "string" &&
      typeof event.terminal === "boolean"
    );
  }
  return event.type === "usage" && usageEvent(line) !== undefined;
}

function recentCompleteLines(logPath: string): string[] {
  let handle: number | undefined;
  try {
    handle = openSync(logPath, "r");
    const size = statSync(logPath).size;
    const length = Math.min(size, 256 * 1024);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(handle, buffer, 0, length, start);
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = raw.split(/\r?\n/);
    if (start > 0) lines.shift();
    if (!/[\r\n]$/.test(raw)) lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export function readRecentOutput(
  logPath: string,
  dialect: OutputDialect,
): string {
  if (dialect === "plain") {
    try {
      return readFileSync(logPath, "utf8").slice(-16_384);
    } catch {
      return "";
    }
  }
  const lines = recentCompleteLines(logPath);
  const events = lines.filter(isRecentEvent).slice(-20);
  while (events.join("\n").length > 16_384) events.shift();
  return events.join("\n");
}
