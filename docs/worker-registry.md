# Worker registry options

A Worker can expose named choices without leaking vendor CLI syntax into MCP calls or skills. `divisi serve` reads the registry selected by `DIVISI_WORKERS_FILE`.

Each option declares:

- `values`: the complete allowlist accepted by `delegate`
- `flag`: the Worker CLI argument template; `{value}` is replaced with the selected value
- `default`: the value used when `delegate` omits that option

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
