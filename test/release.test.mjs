import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { normalizeNpmPackResult } from "../scripts/npm-pack-json.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
const npmCli =
  process.env.npm_execpath ??
  resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repoRoot, path), "utf8"));
}

test("release tooling accepts bundled and current npm pack JSON shapes", () => {
  const pack = { files: [{ path: "package.json" }] };

  assert.equal(normalizeNpmPackResult([pack]), pack);
  assert.equal(normalizeNpmPackResult({ divisi: pack }), pack);
  assert.throws(() => normalizeNpmPackResult({}), /unexpected shape/);
});


let dryRunPackagePromise;
function dryRunPackage() {
  dryRunPackagePromise ??= execFileAsync(
    process.execPath,
    [npmCli, "pack", "--dry-run", "--json"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  ).then(({ stdout }) => {
    const pack = normalizeNpmPackResult(JSON.parse(stdout));
    return pack;
  });
  return dryRunPackagePromise;
}

test("the Codex marketplace installs Divisi's skills and MCP server", async () => {
  const packageJson = await readJson("package.json");
  const plugin = await readJson(".codex-plugin/plugin.json");
  const mcp = await readJson(".mcp.json");
  const marketplace = await readJson(".agents/plugins/marketplace.json");

  assert.equal(plugin.name, "divisi");
  assert.equal(plugin.version, packageJson.version);
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.deepEqual(mcp.mcpServers.divisi, {
    command: "npx",
    args: ["--yes", `divisi@${packageJson.version}`, "serve"],
    cwd: ".",
  });
  assert.equal(marketplace.name, "divisi");
  assert.deepEqual(marketplace.plugins, [
    {
      name: "divisi",
      source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    },
  ]);
});

test("the npm package contains every standalone Divisi runtime asset", async () => {
  const pack = await dryRunPackage();
  const files = new Set(pack.files.map(({ path }) => path));
  const required = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "workers.json",
    "skills/delegating/SKILL.md",
    "skills/delegating/references/workflow.md",
    "skills/prompting-grok/SKILL.md",
    "skills/prompting-kimi/SKILL.md",
    "snippets/global.md",
    "snippets/repo.md",
    "docs/cleanup.md",
    "docs/installer.md",
    "docs/worker-registry.md",
  ];

  assert.deepEqual(required.filter((path) => !files.has(path)), []);
});

test("README alone guides a new adopter to a first reviewed Delegation", async () => {
  const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");
  const requiredPatterns = [
    /codex plugin marketplace add Realevernever\/Divisi/,
    /codex plugin add divisi@divisi/,
    /npm install --global divisi/,
    /\[mcp_servers\.divisi\][\s\S]*command = "divisi"[\s\S]*args = \["serve"\]/,
    /npm install --global @xai-official\/grok/,
    /grok login/,
    /npm install --global @moonshot-ai\/kimi-code/,
    /kimi login/,
    /vendor CLIs own their credentials/i,
    /Divisi never reads, stores, or\s+forwards\s+them/i,
    /codex plugin list --json/,
    /skills\/delegating\/SKILL\.md/,
    /skills\/prompting-grok\/SKILL\.md/,
    /skills\/prompting-kimi\/SKILL\.md/,
    /Prefer delegating suitable work over doing everything yourself\. Good triggers are parallelizable batches, long-horizon tasks, frontend or visual work, and large-context analysis\./,
    /When a `delegate` tool is available, prefer delegating suitable work over doing everything yourself\. Good triggers are parallelizable batches, long-horizon tasks, frontend or visual work, and large-context analysis\./,
    /global custom instructions[^.]*sometimes[^.]*project chats/is,
    /repo[^.]*AGENTS\.md[^.]*more reliable/is,
    /\[MIT\]\(LICENSE\)/,
    /Evernever/,
    /list_workers/,
    /delegate/,
    /review the resulting file and Job result/i,
  ];

  for (const pattern of requiredPatterns) {
    assert.match(readme, pattern);
  }
});

test("the release gate enforces registry names and scans high-confidence value signatures", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [npmCli, "run", "check:credentials"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  );

  assert.match(
    stdout,
    /Credential structural check passed: registry stores names only; no high-confidence credential-value signatures found/,
  );
  const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");
  assert.match(readme, /high-confidence credential-value signatures/);
  assert.match(readme, /not an exhaustive proof/i);
});

test("README plugin-only commands use the pinned npm binary", async () => {
  const packageJson = await readJson("package.json");
  const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");
  const command = `npx --yes divisi@${packageJson.version}`;

  assert.match(readme, new RegExp(`${command} doctor`));
  assert.match(readme, new RegExp(`${command} snippet --target repo`));
  assert.match(
    readme,
    new RegExp(`${command} snippet --target global --print`),
  );
});

test("README keeps comparative Worker routing in the delegating skill", async () => {
  const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");

  assert.doesNotMatch(readme, /Grok 4\.5[^.]*fast, bounded engineering/is);
  assert.doesNotMatch(readme, /Kimi K3[^.]*long repository work/is);
  assert.match(
    readme,
    /task-shape routing lives in\s+`skills\/delegating\/SKILL\.md`/i,
  );
});

test("README provides a reproducible source-tarball walkthrough", async () => {
  const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");

  assert.match(readme, /Maintainers: verify an unpublished checkout/);
  assert.match(readme, /npm pack --pack-destination/);
  assert.match(readme, /npm install --prefix/);
  assert.match(readme, /CODEX_HOME/);
  assert.match(readme, /init --snippet neither/);
  assert.match(
    readme,
    /This walkthrough proves the package from the current checkout/i,
  );
});
