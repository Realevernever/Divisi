import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeNpmPackResult } from "./npm-pack-json.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const npmCli =
  process.env.npm_execpath ??
  resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function repositoryFiles() {
  return run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  )
    .split("\0")
    .filter(Boolean);
}

function packagedFiles() {
  const output = run(process.execPath, [
    npmCli,
    "pack",
    "--dry-run",
    "--json",
  ]);
  const pack = normalizeNpmPackResult(JSON.parse(output));
  return pack.files.map(({ path }) => path);
}

const secretValuePatterns = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["xAI API key value", /\bxai-[A-Za-z0-9_-]{20,}\b/g],
  ["OpenAI-style API key value", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token value", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["AWS access-key value", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Slack token value", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
];

function scanFiles(paths) {
  const findings = [];
  for (const path of paths) {
    const content = readFileSync(resolve(repoRoot, path), "utf8");
    if (content.includes("\0")) continue;
    for (const [label, pattern] of secretValuePatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) findings.push(`${path}: ${label}`);
    }
  }
  return findings;
}

function assertEnvironmentNames(value, label) {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))
  ) {
    throw new Error(`${label} must contain environment-variable names only`);
  }
}

function validateRegistry() {
  const registry = JSON.parse(
    readFileSync(resolve(repoRoot, "workers.json"), "utf8"),
  );
  for (const worker of registry.workers ?? []) {
    assertEnvironmentNames(worker.required_env, `${worker.id}.required_env`);
    if (worker.auth !== undefined) {
      const unknown = Object.keys(worker.auth).filter(
        (key) => !["mode", "observed_env"].includes(key),
      );
      if (unknown.length > 0) {
        throw new Error(`${worker.id}.auth contains unsupported fields: ${unknown}`);
      }
      assertEnvironmentNames(
        worker.auth.observed_env,
        `${worker.id}.auth.observed_env`,
      );
    }
  }
}

const repoFiles = repositoryFiles();
const packageFiles = packagedFiles();
validateRegistry();
const findings = scanFiles(new Set([...repoFiles, ...packageFiles]));
if (findings.length > 0) {
  process.stderr.write(`High-confidence credential-value signature check failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Credential structural check passed: registry stores names only; ` +
      `no high-confidence credential-value signatures found in ` +
      `${repoFiles.length} repository files or ${packageFiles.length} package files.\n`,
  );
}
