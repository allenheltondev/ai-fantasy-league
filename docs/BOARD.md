# Issue board conventions

Work is tracked in GitHub issues. Status lives in labels, so any view (the issue list, a Projects board grouped by label) shows the same state. A weekly grooming run keeps these labels accurate.

## Structure

- **Epics** have the Feature issue type and the `epic` label, plus a `phase-N` label when they map to a spec phase (`docs/SPEC.md` §9).
- **Tasks** have the Task issue type and are attached to their epic as sub-issues.
- **Decisions** have the `decision` label and live under the Open decisions epic (#12). A decision issue is closed once the decision is recorded in `docs/SPEC.md`.

## Status labels

Every open issue has exactly one status label.

| Label | Meaning |
|---|---|
| `status:todo` | Ready to pick up; nothing blocks it. |
| `status:in-progress` | Someone is working on it: it has an assignee, a linked or open PR, or recent commits that reference it. |
| `status:blocked` | Waiting on an open issue named in a `Blocked by #N` line in its body. |

Closed issues carry no status label.

## Rules the weekly grooming run applies

1. **Blocked.** An open issue whose body has `Blocked by #N` with any `#N` still open gets `status:blocked`. Once every referenced issue is closed, it moves to `status:todo`, and the run posts a one-line comment saying it's unblocked.
2. **In progress.** An open issue with an assignee or an open PR that references it gets `status:in-progress`.
3. **Missing or duplicate status.** Any open issue with no status label, or more than one, is normalized using rules 1 and 2, defaulting to `status:todo`.
4. **Epics.**
   - An epic is `status:in-progress` if any of its sub-issues is in progress or closed.
   - It's `status:blocked` only if all of its open sub-issues are blocked.
   - Otherwise it's `status:todo`.
   - When all of an epic's sub-issues are closed, the run comments on the epic suggesting it be closed. It does not close the epic itself.
5. **Stale.** An issue that has been `status:in-progress` for 14 days with no activity gets a single comment asking for an update. The run doesn't post a second one.
6. **Orphans.** A new task with no parent epic is attached to the best-fit epic, and a comment on the task names the epic it was attached to.
7. **Summary.** Each run posts a short digest back to the session:
   - counts by status
   - what changed this week
   - newly unblocked issues
   - the decisions still blocking the most work

The grooming run never closes, reopens, retitles, or rewrites the body of an issue, and it never pushes code. It changes only status labels and sub-issue links, and it posts comments.
