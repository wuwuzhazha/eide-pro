# Team workflow

Rules from real incidents, each enforced by a script. A rule without its
incident record is dropped when memory fades.

## Rules

1. Task cards are written to disk before dispatch; card paths and the base
   SHA are verified at dispatch time with `git ls-files` and
   `git merge-base` (scripted, see Checks).
   Incident: PR-9 changed the lock implementation inside `lib/node-utility`
   (a third-party submodule), leaving the parent repo pointer at a local-only
   commit; CI and other machines would fail outright. Root cause: dispatch
   never checked which repository a path belongs to.

2. Every rule records the incident that bought it.
   Incident: several rules (staging list, test-assertion review, submodule
   check) were added from memory without cause, so later members could not
   tell whether they were still needed.

3. Check that you are not behind the trunk before delivering; run
   `npm run check:branch` and resolve being behind on the member side.
   Incident: two red CI rounds (lock race, test-cleanup timing) required the
   PM to locate the cause; a shared workspace also produced polluted commits.

4. A protocol or command sent to an external tool must have a test that
   executes it with the real tool; mock-only tests prove parsing, not that
   the tool accepts the command.
   Incidents:
   - `-stack-list-variables --all-values` always passed against a fake MI
     stream and always failed against real GDB → frame-variable reads were
     unusable on real hardware.
   - `--frame` used alone is rejected by GDB (`Cannot specify --frame without
     --thread`); the same class of error was committed twice.
   - `eide_debug_continue` returned a stale stop event from before the call →
     an agent would believe the program had stopped when it had not.
   - The QEMU test initially lacked `-S`, so the target ran past its
     breakpoints before the debugger attached → breakpoints never hit.
   - Skipping was allowed locally but not forbidden in CI → the gate could
     pass with the test skipped (now pinned with `EIDE_REQUIRE_QEMU_DEBUG`).

5. Tests must not depend on the host environment (toolchains, PATH, machine
   setup).
   Incidents:
   - A new VS Code-mode regression test (`test/scripts/mcp-impl-regression.test.ts`)
     passed without passing `toolchainPath` because the author's machine had
     the toolchain on PATH; all three CI platforms failed with
     `Toolchain 'GCC' is not installed or its path is not configured: null\bin`.
     Fixed by a stub toolchain (commit `ec5ea86`); completion criterion is now
     "still passes with the host toolchain removed from PATH".
   - Compound symptom: a stale local `out/src` masked a `MODULE_NOT_FOUND`,
     and locally missing QEMU made the test skip before reaching the code,
     masking a fixture path that was missing one directory level.

6. Parallel compilation in a shared workspace produces transient false
   failures; isolate and rerun once before judging a single failure.
   Incidents:
   - A full test run reported `FAIL: routing: disconnected earliest is
     unavailable without falling through` (assertion in
     `test/scripts/instance-routing.test.ts:37`); the file passed 9/9 on
     isolated rerun. Cause: a concurrent `tsc -p ./` was rewriting
     `out/src/mcp/instance_routing.js`.
   - An earlier full run exited with `MODULE_NOT_FOUND:
     out/tmp/test/scripts/utility.test.js`, likewise from concurrent
     compilation rewriting `out/`. CI jobs are environment-isolated and
     unaffected.

7. When a tool's output shape changes, sweep every consumer before
   delivering: `git grep -n <tool_name> -- test scripts docs .github`, including
   tests that only run in CI.
   Incident: `eide_debug_backtrace` changed from a bare array to `{items}`; the
   local suite passed, but `test/scripts/debug-qemu-session.test.ts` (runs only
   in the headless-package CI job) still read the array and failed the first CI
   round (`7266b1e`).

8. Every argument an implementation reads must be declared in the input schema
   of every transport that exposes the tool; the MCP SDK strips undeclared
   fields before the handler sees them.
   Incident: `eide_flash` read `dryRun`, but the non-headless schema did not
   declare it, so the parameter was silently dropped and a dry run programmed
   the device (found in field testing on a real project, fixed in 4.3.2).
   Enforcement: an executable check is tracked by audit lane B, hypothesis H1.

9. Audit findings carry a verbatim quote and, where cheap, an executed
   command; "looks suspicious" without evidence is rejected.
   Incident: unverified review claims cost the PM the same effort to refute as
   the reviewer saved; "none found" conclusions on Keil import and memap
   parsing were later disproved.
   Protocol: `.tasks/audit/PROTOCOL.md` (local, not tracked).

## Checks

Dispatch: `npm run check:task-card -- <card.md>` — validates the card's
verification block only. Prose may mention paths freely; anything outside the
block is not checked. The block sits at the end of the card:

````
## 派单校验
```
base: ead8d57
path: src/core/foo.ts
path: docs/new-file.md (新)
```
````

Paths marked `(新)`（or `(new)`） are created by the task and skip the
tracked-path check; every other `path:` must already be tracked in git.
`base:` must name a real commit that is an ancestor of HEAD. Unknown lines,
a missing block, or a missing base are errors.
Incident: the first verifier scanned backticked paths across the whole card
and reported 6 false positives on example and intentionally-broken paths on
its first use (PROC-1).

Delivery: `npm run check:branch` — fetches the remote and reports the branch
name, how far behind `origin/dev` you are, uncommitted files, and whether you
are ahead. Exit code 1 means rebase or commit first.

A new test that needs a toolchain must pass one explicitly as a stub and be
verified with the host toolchain removed from PATH; see
`test/scripts/mcp-impl-regression.test.ts`. When a full test run fails once,
rerun that file in isolation first: if it passes, treat it as concurrent
compilation noise, not a product defect.

`node scripts/check-out-fresh.js` (also run at the start of `test/run-tests.js`)
checks that every `src/**/*.ts` has an `out/src/**/*.js` at least as new as its
source; if not, it names the first five stale files and exits 1 with
`run: npm run compile`. This closes audit F-C-10: after running only
`compile:test`, a broken validation function still passed because the tests
loaded the old `out/src`. `npm test` compiles both trees first, so it is
unaffected.

## Pre-commit checklist

- `git diff --cached --stat` contains only files in this task card.
- Every test-assertion change can be explained against intended behavior.
- Any `npm test` FAIL lines are quoted in full in the delivery message.
