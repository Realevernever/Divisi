import {
  existsSync,
  copyFileSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const MCP_START = "# divisi:mcp:v1:start";
const MCP_END = "# divisi:mcp:end";

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function assertSafeTarget(root: string, target: string): void {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const relativePath = relative(rootPath, targetPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing target outside its declared root: ${targetPath}`);
  }
  let cursor = rootPath;
  const paths = [cursor];
  for (const part of relativePath.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    paths.push(cursor);
  }
  for (const path of paths) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic link or reparse point in target path: ${path}`,
      );
    }
  }
}

function agentsTarget(root: string): string {
  const agentsOverride = join(root, "AGENTS.override.md");
  return existsSync(agentsOverride) ? agentsOverride : join(root, "AGENTS.md");
}


function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  if (args.indexOf(name, index + 1) !== -1) {
    throw new Error(`${name} may be provided only once`);
  }
  return value;
}

async function promptSnippetTarget(): Promise<string> {
  const prompt = "Nudge snippet target [repo/global/both/neither]: ";
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt);
    return readFileSync(0, "utf8").trim().toLowerCase();
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolveAnswer) => {
      terminal.question(prompt, (answer) => {
        resolveAnswer(answer.trim().toLowerCase());
      });
    });
  } finally {
    terminal.close();
  }
}
function appendOwnedBlock(content: string, block: string): string {
  const separator =
    content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function registerMcpServer(): void {
  const configPath = join(codexHome(), "config.toml");
  assertSafeTarget(codexHome(), configPath);
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const block = [
    MCP_START,
    "[mcp_servers.divisi]",
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(cliPath)}, ${tomlString("serve")}]`,
    MCP_END,
  ].join("\n");
  mkdirSync(dirname(configPath), { recursive: true });
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const pattern = /# divisi:mcp:v\d+:start\r?\n[\s\S]*?^# divisi:mcp:end$/gm;
  const matches = [...current.matchAll(pattern)];
  const starts = current.match(/# divisi:mcp:v\d+:start/g)?.length ?? 0;
  const ends = current.match(/# divisi:mcp:end/g)?.length ?? 0;
  if (starts !== ends || starts !== matches.length) {
    throw new Error("Ambiguous Divisi MCP block markers");
  }
  const outsideOwnedBlock = current.replace(pattern, "");
  if (/^\s*\[mcp_servers\.divisi\]\s*$/m.test(outsideOwnedBlock)) {
    throw new Error("Refusing to replace an unowned [mcp_servers.divisi] table");
  }
  if (matches.length > 1) throw new Error("Multiple Divisi MCP blocks found");
  const match = matches[0];
  const next =
    match
      ? `${current.slice(0, match.index)}${block}${current.slice((match.index ?? 0) + match[0].length)}`
      : appendOwnedBlock(current, block);
  if (next !== current) writeFileSync(configPath, next);
}

const SKILL_FILES = [
  ["delegating", "SKILL.md"],
  ["delegating", "references", "workflow.md"],
  ["prompting-grok", "SKILL.md"],
  ["prompting-kimi", "SKILL.md"],
] as const;


function preflightSkills(home: string): void {
  const sourceRoot = join(packageRoot(), "skills");
  for (const parts of SKILL_FILES) {
    const source = join(sourceRoot, ...parts);
    if (!existsSync(source) || !lstatSync(source).isFile()) {
      throw new Error(`Missing packaged skill asset: ${parts.join("/")}`);
    }
    readFileSync(source);
    assertSafeTarget(home, join(home, "skills", ...parts));
  }
}

function preflightInit(choice: string, repoRoot: string): void {
  const home = codexHome();
  assertSafeTarget(home, join(home, "config.toml"));
  preflightSkills(home);
  if (choice === "repo" || choice === "both") {
    snippetBlock("repo");
    assertSafeTarget(repoRoot, agentsTarget(repoRoot));
  }
  if (choice === "global" || choice === "both") {
    snippetBlock("global");
    assertSafeTarget(home, agentsTarget(home));
  }
}
export function installSkills(): void {
  const sourceRoot = packageRoot();
  const destinationRoot = join(codexHome(), "skills");
  preflightSkills(codexHome());
  for (const parts of SKILL_FILES) {
    const source = join(sourceRoot, "skills", ...parts);
    const destination = join(destinationRoot, ...parts);
    mkdirSync(dirname(destination), { recursive: true });
    const current = existsSync(destination)
      ? readFileSync(destination, "utf8")
      : undefined;
    const shipped = readFileSync(source, "utf8");
    if (current !== shipped) copyFileSync(source, destination);
  }
}

export type SnippetVariant = "repo" | "global";

function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

export function snippetBlock(variant: SnippetVariant): string {
  const body = readFileSync(
    join(packageRoot(), "snippets", `${variant}.md`),
    "utf8",
  ).replace(/\r?\n$/, "");
  return [
    "<!-- divisi:nudge:v1:start -->",
    body,
    "<!-- divisi:nudge:end -->",
  ].join("\n");
}


function lineEnding(content: string): string {
  const match = content.match(/\r\n|\n|\r/);
  return match?.[0] ?? "\n";
}

function appendBlock(content: string, block: string, newline: string): string {
  const separator =
    content.length === 0 ? "" : content.endsWith(newline) ? newline : newline.repeat(2);
  return `${content}${separator}${block}${newline}`;
}

function writeSnippet(variant: SnippetVariant, root: string): string {
  const target = agentsTarget(root);
  assertSafeTarget(root, target);
  const current = existsSync(target)
    ? readFileSync(target, "utf8")
    : "";
  const pattern = /<!-- divisi:nudge:v\d+:start -->\r?\n[\s\S]*?^<!-- divisi:nudge:end -->$/gm;
  const matches = [...current.matchAll(pattern)];
  const starts = current.match(/<!-- divisi:nudge:v\d+:start -->/g)?.length ?? 0;
  const ends = current.match(/<!-- divisi:nudge:end -->/g)?.length ?? 0;
  if (starts !== ends || starts !== matches.length) {
    throw new Error("Ambiguous Divisi nudge block markers");
  }
  if (matches.length > 1) throw new Error("Multiple Divisi nudge blocks found");
  const newline = lineEnding(current);
  const block = snippetBlock(variant).replaceAll("\n", newline);
  const match = matches[0];
  const next = match
    ? `${current.slice(0, match.index)}${block}${current.slice((match.index ?? 0) + match[0].length)}`
    : appendBlock(current, block, newline);
  if (next !== current) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, next);
  }
  return target;
}
export function snippetCommand(args: string[]): number {
  const allowed = new Set(["--target", "--print", "--repo"]);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const unknown = flags.find((flag) => !allowed.has(flag));
  if (unknown) throw new Error(`Unknown snippet option: ${unknown}`);
  const target = optionValue(args, "--target");
  const repoOption = optionValue(args, "--repo");
  if (target !== "repo" && target !== "global") {
    throw new Error("--target must be repo or global");
  }
  if (args.includes("--print")) {
    process.stdout.write(`${snippetBlock(target)}\n`);
    return 0;
  }
  const root =
    target === "global"
      ? codexHome()
      : resolve(repoOption ?? process.cwd());
  const targetPath = writeSnippet(target, root);
  process.stdout.write(`Updated ${targetPath}\n`);
  return 0;
}

export async function initCommand(args: string[]): Promise<number> {
  const allowed = new Set(["--snippet", "--repo"]);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const unknown = flags.find((flag) => !allowed.has(flag));
  if (unknown) throw new Error(`Unknown init option: ${unknown}`);
  let choice = optionValue(args, "--snippet");
  const repoOption = optionValue(args, "--repo");
  if (choice === undefined) choice = await promptSnippetTarget();
  if (!choice || !["repo", "global", "both", "neither"].includes(choice)) {
    throw new Error("--snippet must be repo, global, both, or neither");
  }
  const repoRoot = resolve(repoOption ?? process.cwd());
  preflightInit(choice, repoRoot);
  registerMcpServer();
  installSkills();
  if (choice === "repo" || choice === "both") writeSnippet("repo", repoRoot);
  if (choice === "global" || choice === "both") {
    writeSnippet("global", codexHome());
  }
  process.stdout.write("Divisi MCP server registered and skills installed.\n");
  return 0;
}
