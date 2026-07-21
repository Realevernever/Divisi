<div align="center">

# 🎼 Divisi

**Codex conducts. Other frontier models play their parts.**

</div>

> In an orchestral score, ***divisi*** marks the moment one section divides to
> play several parts at once — still one section, still under one conductor.

That is what this plugin does to a Codex session. Codex stays on the podium.
It hands bounded pieces of work — a batch of independent fixes, a long
refactor, a frontend rebuild — to other frontier models through their own
vendor CLIs. It briefs each one, lets it play, and reviews every note before
anything lands.

## The idea in one minute

Strong models such as Grok 4.5 and Kimi K3 live inside their own coding
CLIs, and each is good at different things. Without help, Codex does
everything itself, one task at a time.

Divisi gives Codex two things:

- **Knowledge** — three editable skills that say which Worker fits which
  task, and how to write a brief that each one follows well.
- **Mechanics** — a small MCP server that launches a Worker's CLI as a
  subprocess, records the job on disk, and reports plain facts when it ends.

A Delegation runs like this:

1. Codex picks a Worker and writes one bounded Task brief.
2. Divisi starts that Worker's own CLI — either in place in your directory,
   or in an isolated git worktree on its own `divisi/<job-id>` branch.
3. The Worker runs detached. Codex keeps working. Closing the session does
   not stop the job; any later session can pick it up again.
4. When the Worker exits, Divisi returns a mechanical Job result: exit
   status, the Worker's final message, a change summary, a log path. Facts
   only — never a verdict on whether the work is good.
5. Codex reads the diff, runs the checks, and decides. Divisi never merges a
   branch for you, never grades the work, and never touches your credentials.

## The players

Divisi ships registry entries and prompting skills for Grok 4.5 and Kimi K3.
Comparative task-shape routing lives in
`skills/delegating/SKILL.md`, where it remains editable instead of hard-coded
into the release.

Adding a Worker of your own is a [registry entry](docs/worker-registry.md)
plus a skill file — no code, as long as its CLI speaks one of the built-in
output dialects.

## Install

You need:

- **Codex** (CLI or Desktop) with plugin support
- **Node.js 22 or newer**
- at least one Worker CLI, installed and signed in by you — see
  [Set up a Worker](#set-up-a-worker)

### Path A — the Codex plugin (recommended)

This repository is a Codex marketplace. Two commands install the skills and
the MCP server together:

```sh
codex plugin marketplace add Realevernever/Divisi
codex plugin add divisi@divisi
```

Start a **new** Codex task so it loads the new skills and tools, and confirm
the install if you like:

```sh
codex plugin list --json
```

The plugin pins its MCP server to the matching `divisi` npm release, so an
installed plugin version stays reproducible instead of silently tracking
"latest". The plugin channel does not put a `divisi` binary on your PATH; when
a section below shows a `divisi` command, plugin users run the pinned form
`npx --yes divisi@0.1.2 <command>` instead.

### Path B — global npm install

For standalone Codex configurations:

```sh
npm install --global divisi
divisi init --snippet neither
```

`divisi init` registers an installer-owned MCP block in your Codex config and
copies the three skills into `$CODEX_HOME/skills` (`CODEX_HOME` defaults to
`~/.codex`). Pass `--snippet repo`, `global`, or `both` if you also want the
[Nudge](#add-the-optional-nudge) applied right away.

<details>
<summary><strong>Prefer to manage config.toml by hand?</strong></summary>

Add this to `$CODEX_HOME/config.toml` yourself:

```toml
[mcp_servers.divisi]
command = "divisi"
args = ["serve"]
```

Then copy the three directories from `<npm root --global>/divisi/skills/`
into `$CODEX_HOME/skills/`. Choose one style and stay with it: `divisi init`
deliberately refuses to replace a `[mcp_servers.divisi]` table it does not
own. [Installer details](docs/installer.md) cover target precedence and the
safety rules.

</details>

## Set up a Worker

The vendor CLIs own their credentials. Divisi never reads, stores, or
forwards them — it only launches a CLI that you have already signed in to.

**Grok 4.5** — install the [Grok Build CLI](https://docs.x.ai/build/cli/reference),
sign in, verify:

```sh
npm install --global @xai-official/grok
grok login
grok --version
```

Grok also supports its documented API-key path; either way the credential
stays with Grok.

**Kimi K3** — install the [Kimi Code CLI](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html),
sign in, verify:

```sh
npm install --global @moonshot-ai/kimi-code
kimi login
kimi --version
```

Kimi's managed OAuth or its own `config.toml` supplies the credential;
exporting a bare provider key is not a substitute.

Then let Divisi check both registry entries — it names environment variables
where relevant but never prints their values:

```sh
divisi doctor            # npm install
npx --yes divisi@0.1.2 doctor   # plugin install
```

Doctor is advisory. A missing *optional* environment variable does not make
vendor-managed sign-in unhealthy.

## Your first Delegation

1. Install Divisi by either path above.
2. Install and sign in to at least one Worker.
3. Run `doctor` and fix any missing CLI or failed version probe.
4. Open a new Codex task in a disposable directory and paste:

```text
Use Divisi. Call list_workers, then choose an available Worker and call delegate
in_place with this directory as working_dir. Ask it to create
divisi-first-delegation.txt containing exactly: Divisi delegation works.
Wait for completion, then independently review the resulting file and Job result.
Do not accept the Worker's final message as proof.
```

Success looks like a `completed` Job result and a reviewed file containing
exactly `Divisi delegation works.` If the call returns only a `job_id`, Codex
checks in with `job_status` at a natural pause and collects `job_result`
after the Worker exits.

## Add the optional Nudge

By default Divisi only *enables* delegation; a short Nudge in `AGENTS.md`
makes it the standing habit for suitable work. The repo variant is assertive,
because the repository has opted in:

```text
Prefer delegating suitable work over doing everything yourself. Good triggers are parallelizable batches, long-horizon tasks, frontend or visual work, and large-context analysis.
```

```sh
# Plugin install
npx --yes divisi@0.1.2 snippet --target repo
# Global npm install
divisi snippet --target repo
```

The global variant is guarded — "when a `delegate` tool is available…" —
because not every repository has Divisi. Print a paste-ready copy for Codex
Desktop's Custom Instructions with:

```text
When a `delegate` tool is available, prefer delegating suitable work over doing everything yourself. Good triggers are parallelizable batches, long-horizon tasks, frontend or visual work, and large-context analysis.
```

```sh
# Plugin install
npx --yes divisi@0.1.2 snippet --target global --print
# Global npm install
divisi snippet --target global --print
```

One known Codex caveat: global custom instructions sometimes do not reach
project chats. For a project that should consistently delegate, the repo
`AGENTS.md` Nudge is the more reliable surface.

## Make it yours

The routing rules and prompting guidance are plain, editable Markdown:

| File | Owns |
|---|---|
| `skills/delegating/SKILL.md` | which Worker gets which task shape |
| `skills/prompting-grok/SKILL.md` | how to brief Grok |
| `skills/prompting-kimi/SKILL.md` | how to brief Kimi |

With a manual install, the live copies sit under `$CODEX_HOME/skills/`. With
a plugin install, run `codex plugin list --json`, find `divisi@divisi`, and
edit under its `source.path` — but note that plugin upgrades can replace
those edits, so keep durable customizations in a forked marketplace or use
the manual install. Start a new Codex task after editing a skill.

## Housekeeping

Worktree Delegations leave behind branches, worktree directories, logs, and
job records. Divisi cleans up in tiers: a **Snapshot commit** preserves a
finished job's uncommitted changes the moment its CLI exits, an automatic
**retention sweep** (at most daily) removes the safe clutter, and anything
irreversible — unmerged `divisi/*` branches above all — waits for you and
`divisi clean`. Details in [docs/cleanup.md](docs/cleanup.md).

## What Divisi will never do

- **Hold your credentials.** It ships invocation recipes and environment
  variable *names*, never values. Vendor credential files stay in each
  vendor CLI's own home and are excluded from the npm package.
  `npm run check:credentials` enforces this shape at publish time — a strong
  guard, though not an exhaustive proof against every credential format.
  The gate scans for high-confidence credential-value signatures.
- **Merge a Worker's branch.** Worktree results come back as a branch and a
  diff; the merge is always a deliberate act by Codex and you.
- **Grade the work.** Job results carry only what the MCP server observed.
  Judgment belongs to the Orchestrator.

<details>
<summary><strong>Maintainers: verify an unpublished checkout</strong></summary>

This walkthrough proves the package from the current checkout without
touching your normal Codex configuration. Run it from the repository root; it
keeps everything under one temporary directory.

Windows PowerShell:

```powershell
$divisiPreRoot = Join-Path ([IO.Path]::GetTempPath()) ("divisi-prerelease-" + [Guid]::NewGuid().ToString("N"))
$divisiPreInstall = Join-Path $divisiPreRoot "install"
New-Item -ItemType Directory -Path $divisiPreRoot -Force | Out-Null
npm pack --pack-destination $divisiPreRoot
npm install --prefix $divisiPreInstall (Join-Path $divisiPreRoot "divisi-0.1.2.tgz")
$env:CODEX_HOME = Join-Path $divisiPreRoot "codex-home"
& (Join-Path $divisiPreInstall "node_modules\.bin\divisi.cmd") init --snippet neither
codex
```

macOS or Linux:

```sh
divisi_pre_root="$(mktemp -d)"
npm pack --pack-destination "$divisi_pre_root"
npm install --prefix "$divisi_pre_root/install" "$divisi_pre_root/divisi-0.1.2.tgz"
export CODEX_HOME="$divisi_pre_root/codex-home"
"$divisi_pre_root/install/node_modules/.bin/divisi" init --snippet neither
codex
```

Keep that terminal open so Codex inherits the isolated `CODEX_HOME`. The
installer copies the packaged skills and registers the tarball-installed MCP
server by absolute path. Then continue with
[Your first Delegation](#your-first-delegation).

</details>

## License

[MIT](LICENSE) — Copyright (c) 2026 Evernever.

*Tutti, but on your cue.*
