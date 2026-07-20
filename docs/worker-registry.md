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

## Output dialects

`output_dialect` is either `plain` or `jsonl-events`. `plain` keeps the existing
contract: the complete log is the final message and `job_status.recent_output`
is its raw 16 KiB tail.

`jsonl-events` is a vendor-neutral UTF-8 JSON Lines contract. Each complete line
is one object with one of these shapes:

- `{ "type": "progress", "message": string }` reports progress.
- `{ "type": "message", "message": string, "terminal": boolean }` reports
  Worker text. The last event with `terminal: true` supplies `final_message`
  verbatim. With no terminal message, `final_message` is the empty string.
- `{ "type": "usage", ...facts }` reports any explicitly observed usage facts:
  `input_tokens`, `output_tokens`, and `total_tokens` are non-negative integers;
  `cost_usd` is a non-negative finite number.

Usage facts are optional. The latest valid value for each explicitly present
field wins, including zero. Divisi never sums, derives, or estimates them.
A Job result contains `usage` only when at least one valid fact was emitted.

While a job runs, `job_status.recent_output` contains the exact JSON source
lines for the latest recognized complete events, joined with newlines. It is
bounded to 20 events and 16 KiB of whole events, parsed from at most the latest
256 KiB of the log; an in-progress partial line is withheld. When the process
has ended, a valid final event is accepted even without a trailing newline.

Malformed JSON, unknown event types, and invalid fields are skipped. Their
original bytes remain in the raw log at `log_path`; they never change the
process-derived status, become a final message, or create usage facts. This
small contract is shared by every Worker entry; vendor-specific branches do not
belong in the parser.

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
