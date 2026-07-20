import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

export class McpClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #stderr = "";

  constructor({ cwd, env }) {
    this.#child = spawn(process.execPath, ["dist/cli.js", "serve"], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk;
    });
    this.#child.on("exit", (code) => {
      const error = new Error(
        `divisi serve exited with code ${code}: ${this.#stderr}`,
      );
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "divisi-test", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
  }

  request(method, params = {}) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return promise;
  }

  async callTool(name, args = {}) {
    const response = await this.request("tools/call", {
      name,
      arguments: args,
    });
    assertToolResponse(response);
    return JSON.parse(response.content[0].text);
  }

  notify(method, params = {}) {
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  async close() {
    if (this.#child.exitCode !== null) return;
    const exited = once(this.#child, "exit");
    this.#child.stdin.end();
    const graceful = Symbol("graceful");
    let timer;
    const outcome = await Promise.race([
      exited.then(() => graceful),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1_000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (outcome === graceful) return;
    this.#child.kill();
    await exited;
  }

  async terminate() {
    if (this.#child.exitCode !== null) return;
    const exited = once(this.#child, "exit");
    this.#child.kill();
    await exited;
  }
}

function assertToolResponse(response) {
  if (response?.isError) {
    throw new Error(response.content?.[0]?.text ?? "Tool call failed");
  }
  if (response?.content?.[0]?.type !== "text") {
    throw new Error(`Unexpected tool response: ${JSON.stringify(response)}`);
  }
}
