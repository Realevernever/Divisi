# Cleanup

Divisi has three cleanup tiers. Every tier operates on finished Delegations
recorded beneath the configured Divisi state directory. Running Delegations are
never cleanup candidates.

## job_cleanup

The MCP tool accepts:

~~~json
{
  "job_id": "the Delegation UUID",
  "discard": false
}
~~~

The **discard** parameter defaults to false. The tool removes a finished
Worktree Delegation's disposable worktree directory. It deletes the exact
**divisi/<job-id>** branch only when git proves that branch is an ancestor of
the consuming repository's current HEAD, or when the caller explicitly sets
**discard** to true. It never merges. Repeating cleanup after the directory or
branch is already absent is safe.

## Retention sweep

**divisi serve** runs an opportunistic Retention sweep at startup. A persistent
**retention-sweep.json** marker in the state directory limits the sweep to once
per 24 hours across server restarts.

Two environment variables configure non-negative day thresholds:

| Variable | Default | Effect |
| --- | ---: | --- |
| DIVISI_WORKTREE_RETENTION_DAYS | 7 | Remove finished job worktree directories and git-proven merged divisi branches |
| DIVISI_RECORD_RETENTION_DAYS | 30 | Remove finished job logs and Job store records |

Setting either value to 0 makes that category eligible at the next due sweep.
Invalid or negative values stop server startup with an error before the marker
or cleanup state changes.

The automatic sweep never deletes an unmerged branch, regardless of age. A
Snapshot commit preserves worktree changes before a finished directory becomes
eligible.

## divisi clean

~~~text
divisi clean [--yes] [--drop-unmerged]
~~~

By default, the command prints the reclaimable worktrees, logs, records, merged
branches, and protected unmerged branches. With empty non-interactive input it
is a dry run and changes nothing. At a terminal it asks **Apply safe cleanup?
[y/N]**; piped **yes** is accepted as the same interactive confirmation.

The **--yes** option is the explicit non-interactive confirmation flag.
Confirmed safe cleanup removes finished worktrees, logs, records, and merged
branches while preserving every unmerged branch.

The **--drop-unmerged** option grants the separate capability to delete
unmerged **divisi/<job-id>** branches. It does not confirm cleanup by itself:
deleting an unmerged branch requires both confirmation (interactive or
**--yes**) and **--drop-unmerged**.

Before confirmed cleanup deletes anything, Divisi preflights every recorded
worktree and log path. Worktree directories must resolve to the exact derived
location beneath the Divisi state root; logs must resolve to
**<state>/logs/<job-id>.log**; repositories and branches must match their
recorded repository and exact **divisi/<job-id>** namespace. Any mismatch fails
closed with a nonzero exit.
