# Divisi

Divisi gives Codex the knowledge and MCP tools to delegate bounded work to
frontier-model vendor CLIs while Codex remains the Orchestrator and reviews the
result.

## What Divisi does

Codex stays in charge. It chooses a Worker, writes a bounded Task brief, starts a
Delegation through Divisi's MCP server, and independently reviews the mechanical
Job result. Divisi wraps the Workers' own coding-agent CLIs; it does not replace
their agent loops, decide whether their work is correct, or merge their changes.

Divisi ships registry entries and prompting skills for Grok 4.5 and Kimi K3.
Setup belongs in this README; task-shape routing lives in
`skills/delegating/SKILL.md`.

## Requirements

- Codex CLI or Codex Desktop with plugin support.
- Node.js 22 or newer. The plugin registration uses `npx` to run the pinned
  Divisi npm release.
- At least one supported vendor CLI, installed and authenticated by you.

**Release status:** `divisi@0.1.0` is not yet published to npm. The normal
plugin and npm instructions below are the post-publication paths; maintainers
verifying the current checkout must use the pre-release walkthrough.

## Install through the Codex plugin channel

This is the primary install path. The repository is a Codex marketplace whose
Divisi plugin bundles the three skills and MCP registration.

```sh
codex plugin marketplace add Realevernever/Divisi
codex plugin add divisi@divisi
```

Start a new Codex task after installation so the new skills and MCP tools are
loaded. Confirm the installation when needed:

```sh
codex plugin list --json
```

The plugin pins its MCP launch to the matching `divisi` npm version. A newly
published plugin version therefore remains reproducible instead of silently
running a different latest package.
The plugin channel does not install a global `divisi` binary. For Divisi CLI
commands below, plugin-only users use the pinned `npx --yes divisi@0.1.0 ...`
form shown beside the shorter command for manual npm installs.

## Manual npm and config.toml install

Standalone Codex configurations can install the executable from npm:

```sh
npm install --global divisi
```

Choose one setup style; do not combine them.

### Installer-managed config

Let Divisi register an owned MCP block and copy all three skills below
`$CODEX_HOME/skills`:

```sh
divisi init --snippet neither
```

Use `--snippet repo`, `global`, or `both` only when you also want the
corresponding Nudge.

### Hand-managed config.toml

If you manage Codex configuration yourself, add this MCP entry to
`$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`):

```toml
[mcp_servers.divisi]
command = "divisi"
args = ["serve"]
```

Copy the three directories from `<npm root --global>/divisi/skills/` into
`$CODEX_HOME/skills/`. Do not run `divisi init` after creating an unowned
`[mcp_servers.divisi]` table: the installer deliberately refuses to replace
configuration it does not own. See [installer details](docs/installer.md) for
target precedence and safety behavior.

## Pre-release maintainer walkthrough

Use this path to prove the package from the current checkout before npm
publication. It keeps the installed tarball and Codex configuration under one
new temporary directory; it does not modify your normal Codex configuration.
Run it from the repository root.

Windows PowerShell:

```powershell
$divisiPreRoot = Join-Path ([IO.Path]::GetTempPath()) ("divisi-prerelease-" + [Guid]::NewGuid().ToString("N"))
$divisiPreInstall = Join-Path $divisiPreRoot "install"
New-Item -ItemType Directory -Path $divisiPreRoot -Force | Out-Null
npm pack --pack-destination $divisiPreRoot
npm install --prefix $divisiPreInstall (Join-Path $divisiPreRoot "divisi-0.1.0.tgz")
$env:CODEX_HOME = Join-Path $divisiPreRoot "codex-home"
& (Join-Path $divisiPreInstall "node_modules\.bin\divisi.cmd") init --snippet neither
codex
```

macOS or Linux:

```sh
divisi_pre_root="$(mktemp -d)"
npm pack --pack-destination "$divisi_pre_root"
npm install --prefix "$divisi_pre_root/install" "$divisi_pre_root/divisi-0.1.0.tgz"
export CODEX_HOME="$divisi_pre_root/codex-home"
"$divisi_pre_root/install/node_modules/.bin/divisi" init --snippet neither
codex
```

Keep that terminal open so Codex inherits the isolated `CODEX_HOME`. The
installer copies the packaged skills and registers the tarball-installed MCP
server by absolute path. Vendor CLI authentication remains in the vendor CLI;
Divisi does not copy it. Continue with [First Delegation](#first-delegation).

## Set up a Worker

The vendor CLIs own their credentials. Divisi never reads, stores, or forwards
them. It only launches a CLI that you have already authenticated. Registry and
doctor output may name an authentication environment variable, such as
`XAI_API_KEY`, but never contain its value.

### Grok 4.5

Install [Grok Build CLI](https://docs.x.ai/build/cli/reference), authenticate,
and verify the command:

```sh
npm install --global @xai-official/grok
grok login
grok --version
```

Grok also supports its vendor-documented API-key path, but credential ownership
still stays with Grok.

### Kimi K3

Install [Kimi Code CLI](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html),
authenticate, and verify the command:

```sh
npm install --global @moonshot-ai/kimi-code
kimi login
kimi --version
```

Kimi's managed OAuth or its own `config.toml` supplies credentials; exporting
a bare provider key is not a substitute for Kimi login/configuration.

Check both registry entries without exposing credential values:

```sh
# Plugin-channel install
npx --yes divisi@0.1.0 doctor
# Manual npm install
divisi doctor
```

Doctor is advisory. A missing optional observed environment variable does not
make vendor-managed authentication unhealthy.

## Customize routing and prompts

The public skill files are intentionally editable Markdown:

- `skills/delegating/SKILL.md` owns comparative routing rules.
- `skills/prompting-grok/SKILL.md` owns Grok Task-brief guidance.
- `skills/prompting-kimi/SKILL.md` owns Kimi Task-brief guidance.

For a plugin-channel install, run `codex plugin list --json`, find
`divisi@divisi`, and use its `source.path` as the plugin root; the files are
under `<source.path>/skills/`. Codex-managed plugin upgrades can replace edits
there, so keep durable customizations in a forked marketplace or use the manual
install.

For a manual install, the editable copies live at:

- `$CODEX_HOME/skills/delegating/SKILL.md`
- `$CODEX_HOME/skills/prompting-grok/SKILL.md`
- `$CODEX_HOME/skills/prompting-kimi/SKILL.md`

`CODEX_HOME` defaults to `~/.codex`. Start a new Codex task after changing a
skill so the task loads the revised instructions.

## Add the optional Nudge

The repo variant is assertive because the repository has opted into Divisi:

```text
Prefer delegating suitable work over doing everything yourself. Good triggers are parallelizable batches, long-horizon tasks, frontend or visual work, and large-context analysis.
```

Apply it to the current repository with:

```sh
# Plugin-channel install
npx --yes divisi@0.1.0 snippet --target repo
# Manual npm install
divisi snippet --target repo
```

The global variant is guarded because Divisi may not be available in every
repository:

```text
When a `delegate` tool is available, prefer delegating suitable work over doing everything yourself. Good triggers are parallelizable batches, long-horizon tasks, frontend or visual work, and large-context analysis.
```

Print a paste-ready copy for Codex Desktop Custom Instructions with:

```sh
# Plugin-channel install
npx --yes divisi@0.1.0 snippet --target global --print
# Manual npm install
divisi snippet --target global --print
```

Known Codex caveat: global custom instructions are sometimes not injected into
project chats. A repo `AGENTS.md` Nudge is therefore the more reliable surface
for a project that should consistently prefer Delegation.

## First Delegation

1. For a pre-release source checkout, complete the pre-release maintainer walkthrough.
   After npm publication, install Divisi through either normal path above.
2. Install and authenticate at least one Worker.
3. Run the `doctor` form matching your install path above and fix any missing
   CLI or failed version probe.
4. Open a new Codex task in a disposable directory and paste:

```text
Use Divisi. Call list_workers, then choose an available Worker and call delegate
in_place with this directory as working_dir. Ask it to create
divisi-first-delegation.txt containing exactly: Divisi delegation works.
Wait for completion, then independently review the resulting file and Job result.
Do not accept the Worker's final message as proof.
```

A successful walkthrough ends with a `completed` Job result and the reviewed
file containing exactly `Divisi delegation works.` If the call returns only a
`job_id`, use `job_status` at a natural pause and `job_result` after the
Worker exits.

## Security and release contents

Divisi ships invocation recipes and authentication variable names, never
credential values. Vendor credential files remain under the vendor CLI's own
home directory and are excluded from the npm package and plugin repository.

`npm run check:credentials` structurally enforces that registry authentication
entries store environment-variable names only and scans repository and package
text for a bounded set of high-confidence credential-value signatures. This
guard is not an exhaustive proof against every token format, encoding, or
future credential shape.

The npm package contains the `divisi` executable, default `workers.json`,
three skills, Nudge snippets, plugin manifests, and operational documentation.

## License

Divisi is available under the [MIT License](LICENSE).

Copyright (c) 2026 Evernever.
