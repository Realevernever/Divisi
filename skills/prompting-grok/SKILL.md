---
name: prompting-grok
description: Writes focused Task briefs for Grok 4.5. Use after the delegating skill has selected Grok 4.5 as the Worker for a Delegation.
---

# Prompting Grok 4.5

Write a short work order with one fixed result. Give exact paths and checks. Cut context that does not help the task.

## Exploit these strengths

- Repeated inspect, edit, run, and repair loops
- Repo coding, tests, builds, logs, scripts, and shell work
- Clear data shapes and bulk changes with hard checks
- Fast use of tools on bounded work

Ground factual work in supplied files or approved search. Ask for sources and dates when facts may change.

## Never hand it

- Unsupported factual recall
- Sole review, grading, or final approval of its own work
- High-stakes legal, medical, financial, safety, or compliance judgment
- Open-ended production access or a vague request to change what seems useful
- Final prose where voice or taste decides success

## Build the Task brief

Use these parts in order:

1. **Objective:** one result that a check can prove.
2. **Context:** only the needed files, facts, and current state.
3. **Scope:** exact paths it may change and items it must leave alone.
4. **Tools:** allowed tools and when it may search.
5. **Checks:** commands or rules that prove the result.
6. **Output:** changed files, checks run, open risks, and a short result.
7. **Stop points:** missing input, work outside scope, or repeated failed repair.

Tell Grok to report only work it did. Ask it to stop with the exact block instead of guessing.

## Set effort

The registry default for `effort` is `high`. Dial it down when the task does not need that depth:

- `low`: small edits, formatting, extraction, safe bulk changes, or simple tool calls
- `medium`: normal multi-file coding, data work, or bounded analysis
- `high`: hard bugs, broad dependencies, or long tool loops

## Example

```text
Objective: Fix the named parser bug and add a failing-then-passing regression test.
Context: Inspect src/parser.ts and test/parser.test.ts. The issue body defines the expected result.
Scope: Change only those files. Keep the public API stable.
Tools: Use local repo tools. Do not search the web.
Checks: Run npm test and npm run build.
Output: List changed files, exact check results, and remaining risk.
Stop: Report the missing fact or failing check if the work cannot finish in scope.
```
