# Installer commands

`divisi init` registers Divisi in Codex, installs its three skills, and asks where to place the Nudge snippet.

```text
divisi init [--snippet repo|global|both|neither] [--repo PATH]
```

Without `--snippet`, `init` prompts for `repo`, `global`, `both`, or `neither`. The `--snippet` flag is the noninteractive equivalent. `--repo` defaults to the current working directory.

Codex files are written below `CODEX_HOME` when that environment variable is set, otherwise below `~/.codex`. The MCP registration is an owned, versioned block in `config.toml`. The installer preserves unrelated TOML and replaces only an earlier Divisi-owned block. It installs these files without deleting local extras:

- `skills/delegating/SKILL.md`
- `skills/delegating/references/workflow.md`
- `skills/prompting-grok/SKILL.md`
- `skills/prompting-kimi/SKILL.md`

`divisi snippet` writes or prints one Nudge variant:

```text
divisi snippet --target repo|global [--repo PATH] [--print]
```

The repo variant is assertive. The global variant begins with the guard “When a `delegate` tool is available” and is ready to paste into Codex Desktop Custom Instructions. `--print` writes only to stdout and never changes a file.

For either scope, an existing `AGENTS.override.md` takes precedence over `AGENTS.md`. Snippets use a versioned owned marker block, so reruns are idempotent and an old Divisi block is replaced without changing unrelated bytes. Ambiguous markers, unowned MCP conflicts, missing flag values, and symbolic-link or reparse-point targets are refused before writes.
