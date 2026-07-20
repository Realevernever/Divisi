---
name: delegating
description: Chooses when and how to delegate Codex work to a Divisi Worker. Use for parallel batches, long-running work, frontend or visual work, large-context analysis, or any bounded task that a Worker could carry while the Orchestrator stays in charge.
---

# Delegating

Use this skill before choosing a Worker. After the choice, load that Worker's prompting skill.

## Choose a Worker

| Worker | Best fit | Poor fit |
|---|---|---|
| Grok 4.5 | Fast, low-cost, bounded engineering with clear checks; safe bulk work | Open-ended judgment, unsupported facts, final review, or style-led prose |
| Kimi K3 | Long repo work, huge source sets, frontend or visual work, and long tool loops | Short routine work, fast chat, or unsupported facts |

Delegate when the task has a clear result and a Worker can make useful progress on its own. Keep work when the brief would take as long as the task, the next step needs user judgment, or no sound check can catch a costly error.

## Pick isolation

- Use `in_place` for short work when you can leave the tree alone until it ends.
- Use `worktree` for long work, parallel work, or any job that may outlive the session. Long jobs belong in worktrees.

## Run the Delegation

1. Load `prompting-grok` or `prompting-kimi` after choosing the Worker.
2. Write one bounded Task brief with scope, checks, output, and stop points.
3. Start the job, then keep working. Check it at a natural pause instead of polling without cause.
4. Follow [review, recovery, and cleanup](references/workflow.md) when the job ends.

Example: send five independent, testable fixes to separate Grok worktree jobs; keep a repo-wide visual rebuild in one Kimi worktree job.
