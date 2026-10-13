# Release Notes 0.2.8

## Highlights

- Fixed #10: non-atomic steps at decomposition depth 4 now converge on an explicit blocker recovery instead of recommending another rejected `task_decompose` call.
- Fixed #8: evidence schemas expose reducer text limits, and command/test/dogfood recovery templates preserve valid commands while replacing invalid values with caller-supplied placeholders.
- Fixed #9: conditional scope fields are model-visible, and missing `activity` or `scope_reason` now returns a targeted snake_case `task_update` recovery.
- Fixed #11: action-like filename segments such as `fixtures/fix.json`, `update.json`, and `then.json` no longer reduce plan quality; genuine broad and compound instructions remain guarded.
- Updated transitive `source-map-js` to `1.2.2` after the release audit detected GHSA-68fv-2mgg-jv7q.

## Recovery Contracts

At decomposition depth 4, `task_resume`, `task_next`, `task_focus`, `task_granularity_check`, task state, and rejected mutation output now agree on one executable path: explicitly block the unfinished task and carry remaining scope plus evidence references into a manually planned flat successor. The reducer still rejects further decomposition and premature completion; no successor is created automatically.

Evidence fields now declare the runtime limits enforced by the reducer:

| Field | Maximum characters |
|---|---:|
| `summary` | 500 |
| `quality.observedOutput` | 1,000 |
| each reference, artifact reference, source, or command | 300 |

Recovery templates do not truncate commands into different commands. Valid values are retained; missing or over-limit values become explicit placeholders that the caller must replace with observed data.

`task_update.scope` requires non-empty `activity`. `scope_change` and `off_plan` additionally require `scope_reason`. These two rejection classes now recommend the corrected `task_update` call even when the task's ordinary next action is a different tool.

## Verification Status

- Passed: `PI_SDK_ROOT=/tmp/pi-tasks-sdk-1.2.0/node_modules/@earendil-works/pi-coding-agent npm run release:check` after the 0.2.8 version bump: strict typecheck, Biome, 88 unit tests, 7 native Pi SDK tests, build, source/dist imports, pack dry-run, clean tarball install/import, and zero-vulnerability audit.
- Passed: native recovery coverage validated host schema rejection at the 301-character command boundary, a runtime-only evidence rejection, a host-valid corrected retry, JSONL persistence, and evidence restoration in a new session.
- Passed: real Pi 0.87.1 source dogfood with OpenAI Codex GPT-5.5 in English and Traditional Chinese rejected compound plans, future-step evidence, and over-500-character summaries, then converged on `task_evidence` for the current step.
- Passed: real Pi lifecycle dogfood accepted `fixtures/fix.json` at plan quality 100, returned targeted scope recovery, preserved a valid evidence command, rejected out-of-order updates, deduplicated evidence, rendered decisions/blockers, completed at 100%, restored the session, and replayed a fork.
- Passed: real Pi maximum-depth dogfood reached `T1-S1.1.1.1.1`, made all four guidance surfaces select `task_update`, rejected a fifth decomposition without persistence, applied the blocker recovery, and exposed `task_plan` without completing work or creating a successor.
- Passed: live Pi TUI `/tasks detail` rendered the completed task, two evidence records, resolved blocker, and decision; `/quit` exited with code 0.
- Passed: clean `pi-tasks-0.2.8.tgz` consumer install, package import, zero-vulnerability audit, and installed-extension weak-model smoke through `node_modules/pi-tasks/dist/index.js`.
