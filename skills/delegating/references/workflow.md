# Delegation workflow

## While a job runs

- Let detached jobs run while you do other work.
- Use `job_status` at a natural pause when recent output could change your plan.
- Use `job_list` to find jobs from an earlier session.
- Cancel only when the job is wrong, unsafe, or no longer useful. A closed Codex session does not stop it.

## Review the result

A Job result gives process facts, the Worker's final message, git changes, use data, and a log path. It does not say whether the work is good.

1. Read the final message and changed-file summary. Read the log when the result is unclear.
2. Inspect the full diff for scope, design, and stray changes.
3. Run the checks from the Task brief yourself. Add checks when the diff exposes a risk the brief missed.
4. For an in-place job, keep or revise the edits only after review.
5. For a worktree job, inspect its branch and Snapshot commit. Merge it deliberately only after the work passes. Divisi never merges it for you.

Do not accept a clean process exit, a confident final message, or a Snapshot commit as proof that the task passed.

## Recover weak work

Use this order:

1. Give the same Worker a sharper brief with the failed check and current state.
2. Switch Worker when the task shape no longer fits the first choice.
3. Take over when another Delegation would cost more than finishing the work.

Keep useful edits and test output when you retry. Do not make the next Worker repeat sound work.

## Clean up

After you merge or discard a result, call `job_cleanup`. This removes normal job clutter while keeping the choice to merge or discard with you.
