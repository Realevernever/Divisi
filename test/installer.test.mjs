import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function runDivisi(args, { cwd, codexHome, input } = {}) {
  return spawnSync(process.execPath, [resolve(repoRoot, "dist", "cli.js"), ...args], {
    cwd: cwd ?? repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: resolve(codexHome, "fake-home"),
      USERPROFILE: resolve(codexHome, "fake-profile"),
    },
    input,
    windowsHide: true,
  });
}

test("init idempotently registers Divisi without disturbing unrelated Codex config", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-init-config-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome, { recursive: true });
  await mkdir(repo);
  const configPath = resolve(codexHome, "config.toml");
  const unrelated = '[projects."C:\\\\work"]\ntrust_level = "trusted"\n';
  await writeFile(configPath, unrelated);

  const first = runDivisi(["init", "--snippet", "neither"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = await readFile(configPath, "utf8");
  assert.equal(afterFirst.startsWith(unrelated), true);
  assert.match(afterFirst, /# divisi:mcp:v1:start/);
  assert.match(afterFirst, /\[mcp_servers\.divisi\]/);
  assert.match(afterFirst, /args = \[.*dist\\\\cli\.js.*"serve"\]/);

  const second = runDivisi(["init", "--snippet", "neither"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(configPath, "utf8"), afterFirst);
  assert.equal(afterFirst.match(/\[mcp_servers\.divisi\]/g)?.length, 1);
});

test("init installs the three Codex skills and Delegation workflow reference", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-init-skills-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(resolve(codexHome, "skills", "delegating"), { recursive: true });
  await mkdir(repo);
  const extraPath = resolve(
    codexHome,
    "skills",
    "delegating",
    "my-local-notes.md",
  );
  await writeFile(extraPath, "keep me\n");

  const result = runDivisi(["init", "--snippet", "neither"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(result.status, 0, result.stderr);

  const installed = [
    ["delegating", "SKILL.md"],
    ["delegating", "references", "workflow.md"],
    ["prompting-grok", "SKILL.md"],
    ["prompting-kimi", "SKILL.md"],
  ];
  for (const parts of installed) {
    const expected = await readFile(resolve(repoRoot, "skills", ...parts), "utf8");
    const actual = await readFile(
      resolve(codexHome, "skills", ...parts),
      "utf8",
    );
    assert.equal(actual, expected);
  }
  assert.equal(await readFile(extraPath, "utf8"), "keep me\n");
});

test("snippet prints a paste-ready guarded global variant without writing files", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-snippet-print-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);

  const result = runDivisi(
    ["snippet", "--target", "global", "--print"],
    { cwd: repo, codexHome },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^<!-- divisi:nudge:v1:start -->\r?\n/);
  assert.match(
    result.stdout,
    /When a `delegate` tool is available, prefer delegating suitable work over doing everything yourself\./,
  );
  await assert.rejects(readFile(resolve(codexHome, "AGENTS.md"), "utf8"));
});

test("snippet replaces an old repo nudge once while preserving unrelated bytes", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-snippet-repo-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);
  const agentsPath = resolve(repo, "AGENTS.md");
  const before = [
    "# Local rules",
    "Keep this line exactly.",
    "",
    "<!-- divisi:nudge:v0:start -->",
    "Old wording.",
    "<!-- divisi:nudge:end -->",
    "",
    "Tail stays too.",
    "",
  ].join("\r\n");
  await writeFile(agentsPath, before);

  const first = runDivisi(
    ["snippet", "--target", "repo", "--repo", repo],
    { cwd: fixture, codexHome },
  );
  assert.equal(first.status, 0, first.stderr);
  const after = await readFile(agentsPath, "utf8");
  assert.equal(after.startsWith("# Local rules\r\nKeep this line exactly.\r\n\r\n"), true);
  assert.equal(after.endsWith("\r\n\r\nTail stays too.\r\n"), true);
  assert.match(after, /<!-- divisi:nudge:v1:start -->/);
  assert.match(
    after,
    /Prefer delegating suitable work over doing everything yourself\./,
  );
  assert.doesNotMatch(after, /When a `delegate` tool is available/);
  assert.equal(after.match(/divisi:nudge:v1:start/g)?.length, 1);
  assert.doesNotMatch(after, /divisi:nudge:v0:start|Old wording/);

  const second = runDivisi(
    ["snippet", "--target", "repo", "--repo", repo],
    { cwd: fixture, codexHome },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(agentsPath, "utf8"), after);
});

test("snippet honors AGENTS.override.md precedence at global and repo levels", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-snippet-override-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);
  const globalAgents = resolve(codexHome, "AGENTS.md");
  const globalOverride = resolve(codexHome, "AGENTS.override.md");
  const repoAgents = resolve(repo, "AGENTS.md");
  const repoOverride = resolve(repo, "AGENTS.override.md");
  await writeFile(globalAgents, "global base untouched\n");
  await writeFile(globalOverride, "global override\n");
  await writeFile(repoAgents, "repo base untouched\n");
  await writeFile(repoOverride, "repo override\n");

  const global = runDivisi(["snippet", "--target", "global"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(global.status, 0, global.stderr);
  const repoResult = runDivisi(
    ["snippet", "--target", "repo", "--repo", repo],
    { cwd: fixture, codexHome },
  );
  assert.equal(repoResult.status, 0, repoResult.stderr);

  assert.equal(await readFile(globalAgents, "utf8"), "global base untouched\n");
  assert.equal(await readFile(repoAgents, "utf8"), "repo base untouched\n");
  assert.match(
    await readFile(globalOverride, "utf8"),
    /When a `delegate` tool is available/,
  );
  const repoText = await readFile(repoOverride, "utf8");
  assert.match(
    repoText,
    /Prefer delegating suitable work over doing everything yourself/,
  );
  assert.doesNotMatch(repoText, /When a `delegate` tool is available/);
});

test("init noninteractively applies both consented snippet targets", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-init-both-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);

  const result = runDivisi(
    ["init", "--snippet", "both", "--repo", repo],
    { cwd: fixture, codexHome },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    await readFile(resolve(repo, "AGENTS.md"), "utf8"),
    /Prefer delegating suitable work over doing everything yourself/,
  );
  assert.match(
    await readFile(resolve(codexHome, "AGENTS.md"), "utf8"),
    /When a `delegate` tool is available/,
  );
});

test("init fails closed on an unowned Divisi MCP table without changing config", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-init-conflict-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);
  const configPath = resolve(codexHome, "config.toml");
  const before = '[mcp_servers.divisi]\ncommand = "someone-elses-command"\n';
  await writeFile(configPath, before);

  const result = runDivisi(["init", "--snippet", "neither"], {
    cwd: repo,
    codexHome,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unowned \[mcp_servers\.divisi\] table/);
  assert.equal(await readFile(configPath, "utf8"), before);
  await assert.rejects(
    readFile(resolve(codexHome, "skills", "delegating", "SKILL.md"), "utf8"),
  );
});

test("snippet fails closed on unmatched owned markers without changing the target", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-snippet-ambiguous-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);
  const agentsPath = resolve(repo, "AGENTS.md");
  const before = "unrelated\n<!-- divisi:nudge:v0:start -->\nunterminated\n";
  await writeFile(agentsPath, before);

  const result = runDivisi(["snippet", "--target", "repo"], {
    cwd: repo,
    codexHome,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ambiguous Divisi nudge block markers/);
  assert.equal(await readFile(agentsPath, "utf8"), before);
});

test("init refuses a skill directory reparse point that escapes CODEX_HOME", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-init-reparse-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  const outside = resolve(fixture, "outside");
  const sentinel = resolve(outside, "SKILL.md");
  await mkdir(resolve(codexHome, "skills"), { recursive: true });
  await mkdir(repo);
  await mkdir(outside);
  await writeFile(sentinel, "outside must survive\n");
  await symlink(outside, resolve(codexHome, "skills", "delegating"), "junction");

  const result = runDivisi(["init", "--snippet", "neither"], {
    cwd: repo,
    codexHome,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link or reparse point/);
  assert.equal(await readFile(sentinel, "utf8"), "outside must survive\n");
  await assert.rejects(readFile(resolve(codexHome, "config.toml"), "utf8"));
});

test("installer commands reject duplicate owned blocks without mutation", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-owned-duplicates-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);
  const configPath = resolve(codexHome, "config.toml");
  const agentsPath = resolve(repo, "AGENTS.md");
  const configBlock = [
    "# divisi:mcp:v0:start",
    "[mcp_servers.divisi]",
    'command = "old"',
    "# divisi:mcp:end",
  ].join("\n");
  const snippetBlock = [
    "<!-- divisi:nudge:v0:start -->",
    "old",
    "<!-- divisi:nudge:end -->",
  ].join("\n");
  const configBefore = `${configBlock}\n${configBlock}\n`;
  const agentsBefore = `${snippetBlock}\n${snippetBlock}\n`;
  await writeFile(configPath, configBefore);
  await writeFile(agentsPath, agentsBefore);

  const init = runDivisi(["init", "--snippet", "neither"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(init.status, 1);
  assert.match(init.stderr, /Multiple Divisi MCP blocks found/);
  assert.equal(await readFile(configPath, "utf8"), configBefore);

  const snippet = runDivisi(["snippet", "--target", "repo"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(snippet.status, 1);
  assert.match(snippet.stderr, /Multiple Divisi nudge blocks found/);
  assert.equal(await readFile(agentsPath, "utf8"), agentsBefore);
});

test("init accepts piped interactive snippet consent with a flag-equivalent choice", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-init-interactive-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);

  const result = runDivisi(["init", "--repo", repo], {
    cwd: fixture,
    codexHome,
    input: "global\n",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nudge snippet target \[repo\/global\/both\/neither\]:/);
  assert.match(
    await readFile(resolve(codexHome, "AGENTS.md"), "utf8"),
    /When a `delegate` tool is available/,
  );
  await assert.rejects(readFile(resolve(repo, "AGENTS.md"), "utf8"));
});

test("installer flags fail closed when an option value is missing", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-missing-option-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);

  const snippet = runDivisi(["snippet", "--target", "repo", "--repo"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(snippet.status, 1);
  assert.match(snippet.stderr, /--repo requires a value/);
  await assert.rejects(readFile(resolve(repo, "AGENTS.md"), "utf8"));

  const init = runDivisi(["init", "--snippet", "neither", "--repo"], {
    cwd: repo,
    codexHome,
  });
  assert.equal(init.status, 1);
  assert.match(init.stderr, /--repo requires a value/);
  await assert.rejects(readFile(resolve(codexHome, "config.toml"), "utf8"));
});

test("init replaces one old owned MCP block without changing unrelated config bytes", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "divisi-init-version-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const codexHome = resolve(fixture, "codex");
  const repo = resolve(fixture, "repo");
  await mkdir(codexHome);
  await mkdir(repo);
  const configPath = resolve(codexHome, "config.toml");
  const before = [
    "unrelated = true",
    "# divisi:mcp:v0:start",
    "[mcp_servers.divisi]",
    'command = "old"',
    'args = ["old"]',
    "# divisi:mcp:end",
    "tail = 42",
    "",
  ].join("\r\n");
  await writeFile(configPath, before);

  const result = runDivisi(["init", "--snippet", "neither"], {
    cwd: repo,
    codexHome,
  });

  assert.equal(result.status, 0, result.stderr);
  const after = await readFile(configPath, "utf8");
  assert.equal(after.startsWith("unrelated = true\r\n"), true);
  assert.equal(after.endsWith("\r\ntail = 42\r\n"), true);
  assert.equal(after.match(/# divisi:mcp:v1:start/g)?.length, 1);
  assert.doesNotMatch(after, /divisi:mcp:v0:start|command = "old"/);
});
