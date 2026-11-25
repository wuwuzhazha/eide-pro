# Team workflow

Three rules from real incidents, each enforced by a script. A rule without its
incident record is dropped when memory fades.

## Rules

1. Task cards are written to disk before dispatch; card paths and the base
   SHA are verified at dispatch time.
   Incident: PR-9 changed the lock implementation inside `lib/node-utility`
   (a third-party submodule), leaving the parent repo pointer at a local-only
   commit; CI and other machines would fail outright. Root cause: dispatch
   never checked which repository a path belongs to.

2. Every rule records the incident that bought it.
   Incident: several rules (staging list, test-assertion review, submodule
   check) were added from memory without cause, so later members could not
   tell whether they were still needed.

3. Check that you are not behind the trunk before delivering.
   Incident: two red CI rounds (lock race, test-cleanup timing) required the
   PM to locate the cause; a shared workspace also produced polluted commits.

## Checks

Dispatch: `npm run check:task-card -- <card.md>` — verifies every
backtick-quoted repository path exists (paths marked （新） are new files and
skip the check) and that `基线：<sha>` names a real ancestor of HEAD.

Delivery: `npm run check:branch` — fetches the remote and reports the branch
name, how far behind `origin/dev` you are, uncommitted files, and whether you
are ahead. Exit code 1 means rebase or commit first.

## Pre-commit checklist

- `git diff --cached --stat` contains only files in this task card.
- Every test-assertion change can be explained against intended behavior.
- Any `npm test` FAIL lines are quoted in full in the delivery message.
