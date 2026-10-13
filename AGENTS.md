# Development Rules

## Product Goal

Build a Pi-native task and progress contract that lets both the agent and the user understand:

- what is being implemented,
- why it is being implemented,
- current progress and blockers,
- acceptance criteria,
- verification evidence,
- user decisions,
- and whether the task is truly complete.

This project must align with the commercial-quality bar established by `pi-knowledge`: verified behavior, clear docs, release gates, and no misleading claims.

## Architecture Baseline

- Target runtime: Pi coding agent extension system.
- Primary state should be Pi session-aware and branch-aware.
- The extension should use Pi-native APIs before external protocols:
  - `registerTool`
  - `registerCommand`
  - `appendEntry`
  - `setLabel`
  - `ctx.ui.setWidget`
  - `ctx.ui.setStatus`
  - lifecycle events such as `session_start`, `session_tree`, `turn_end`, and `session_shutdown`
- MCP or Markdown export can be added later, but should not replace the Pi-native core.
- Preserve Oh My Pi compatibility when using Pi-native APIs:
  - keep package manifests readable through `pi.extensions`;
  - avoid relying on `ctx.mode`; use API capability checks such as `ctx.hasUI` only when needed;
  - mirror critical `promptGuidelines` into tool `description` text because Oh My Pi consumes `description`/`parameters` for model-facing tool guidance.

## Task State Event Contract

- Publish `pi-tasks:state` only after the default status/widget refresh completes.
- Publish on `session_start`, `session_tree`, and every successful persisted task mutation; rejected mutations must not publish.
- Keep payload versioned. Version 1 contains `reason`, stable `widgetId`, and a task-state snapshot without raw event history.
- Structured-clone snapshots before publication so consumers cannot mutate runtime store state.
- Isolate observer failures from task persistence and tool success.
- Preserve default UI when no consumer subscribes. A synchronous consumer may intentionally replace the default widget through the published `widgetId`.

## Implementation Rules

- TypeScript strict mode.
- ESM only.
- No `any` unless the boundary truly requires it and the rationale is documented.
- Keep startup light. Avoid loading optional UI-heavy modules at extension import time unless Pi requires them.
- Prefer deterministic local state transitions over prompt-only behavior.
- `task_plan` and `task_resume` must have clear `promptSnippet` and `promptGuidelines`, with critical guidance reflected in `description` for hosts that ignore custom prompt fields. Lazily activated task controls use compact descriptions without active-only prompt metadata.
- Long-running operations must support cancellation where applicable.
- TUI custom renderers and widgets must be width-safe and tested in real Pi TUI sessions.

## Product Rules

- This is not just a todo list.
- Every active task must be able to answer:
  - objective,
  - current status,
  - next action,
  - acceptance criteria,
  - verification evidence,
  - unresolved user decisions,
  - and completion confidence.
- The system must not mark work complete without verification evidence.
- The agent may propose task changes, but user-facing decisions must be recorded explicitly.

## Runtime Recovery Contracts

- A non-atomic step at decomposition depth 4 must direct every guidance surface to an explicit `task_update` blocker; never recommend another decomposition, mark the step done, or create a successor automatically.
- Evidence schemas and reducer validation must share the 500-character summary, 1,000-character observed-output, and 300-character reference/source/command limits. Rejected command, test, and dogfood evidence retries must preserve valid submitted values and use explicit caller-replacement placeholders for missing or over-limit values.
- Supplying `task_update.scope` requires non-empty `activity`; `scope_change` and `off_plan` also require `scope_reason`. Those reducer rejections must recover with a corrected snake_case `task_update`, not the task's unrelated next action.
- Plan-quality wording guards must ignore action-like words inside path tokens while retaining broad-action and compound-action detection, including action words followed by sentence punctuation.


## Verification Rules

Before claiming readiness:

- Run unit tests.
- Run `node --experimental-strip-types -e "import('./index.ts')"`.
- Run `npm pack --dry-run`.
- Run Pi dogfood with at least:
  - task creation,
  - task update,
  - `/tasks` command,
  - session resume,
  - branch/fork behavior if implemented,
  - and `/quit` clean exit.

Skipped gates must be reported as skipped, not passed.

## Documentation Rules

- Behavior contracts belong in `AGENTS.md`.
- User-facing capabilities belong in `README.md`.
- Product and architecture planning belongs in `docs/`.
- Release process must be documented before the first npm release.

