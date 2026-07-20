# Worker registry options

A Worker can expose named choices without leaking vendor CLI syntax into MCP calls or skills. `divisi serve` reads the registry selected by `DIVISI_WORKERS_FILE`.

Each option declares:

- `values`: the complete allowlist accepted by `delegate`
- `flag`: the Worker CLI argument template; `{value}` is replaced with the selected value
- `default`: the value used when `delegate` omits that option

Worker entries may also declare:

- `required_env`: auth environment variable names reported by `divisi doctor`;
  the registry never contains their values
- `version_args`: arguments used by `divisi doctor` to read the CLI version;
  when omitted, Divisi uses `["--version"]`

### Doctor output

`divisi doctor` prints one tab-separated row per Worker:

```text
<id>  cli=found|not-found  version=<output>  <ENV_NAME>=set|not-set
```

The version column is present only when the command is found. A missing command,
a non-zero or empty version response, or any missing required environment
variable makes the command exit non-zero; otherwise it exits zero. Version
commands receive only PATH lookup and operating-system process essentials, never
the named auth variables. Doctor creates no logs and remains advisory:
`delegate` does not consult probe results.

Template tokens separated by whitespace become separate CLI arguments. The shipped example leans toward high reasoning effort:

```json
{
  "workers": [
    {
      "id": "example",
      "capability_summary": "An example Worker.",
      "command": "worker-cli",
      "args": ["run", "{task_brief}", "--working-dir", "{working_dir}"],
      "output_dialect": "plain",
      "options": {
        "effort": {
          "values": ["low", "medium", "high"],
          "flag": "--effort {value}",
          "default": "high"
        }
      }
    }
  ]
}
```

Callers use only the option name and value:

```json
{
  "options": {
    "effort": "medium"
  }
}
```

An omitted option uses its registry default. An unknown option name or value fails before a Worker starts. `list_workers` reports option names, allowed values, and defaults, but never returns `flag`; the Worker registry alone owns vendor flag syntax.
