# pi-tasks

> Pi-native execution contracts for AI agents — no more "trust me, it's done."

## Why pi-tasks?

AI coding agents say "done" without proof. Context compaction loses progress. Multi-step work drifts without anyone noticing. You end up asking "what's the status?" over and over.

**pi-tasks** gives your Pi agent a binding execution contract: structured plans, evidence gates, ordered execution, and compaction-safe resume — all visible in your TUI.

## What makes it different

Every other task tool for AI agents is just a todo list. pi-tasks enforces three hard contracts no competitor offers:

| Contract | What it means |
|----------|---------------|
| **Evidence-gated completion** | Agents cannot mark work done without traceable, reproducible proof |
| **Atomic step decomposition** | Vague or compound steps are rejected; non-atomic steps must be broken down before execution |
| **Compaction-safe resume** | Context window limits don't lose your progress — snapshot replay picks up exactly where you left off |

Plus: ordered step execution, scope drift detection, weak-model recovery guidance, decision/blocker audit trails, and branch-aware persistence.

## Competitive landscape

Different tools solve different parts of the agentic workflow. Pick based on what matters most to your team:

| Tool | Focus | Strengths | Trade-offs |
|------|-------|-----------|------------|
| **Claude Code Tasks** (built-in) | Cross-session coordination | Shared task lists, dependency tracking, zero setup | No completion verification, no step-level contracts |
| **rpiv-pi** (9.4K/mo, 413★) | Structured workflows | 6 end-to-end flows, 12 subagents, code-review loops | Workflow-oriented; task visibility via separate rpiv-todo |
| **@tintinweb/pi-tasks** (3.2K/mo, 113★) | Task tracking & subagents | Dependency DAG, auto-cascade, file/session/project scoping | Tracks progress; completion is self-reported |
| **Microsoft hve-core** (1,183★) | RPI workflow for Copilot | Research→Plan→Implement→Review, custom agents | Copilot-native; not designed for Pi |
| **pi-tasks** (this project) | Execution contracts | Evidence-gated completion, atomic decomposition, compaction-safe resume | Narrower scope; no subagent orchestration (yet) |

**pi-tasks is for you if** your core problem is agents claiming "done" without proof, plans drifting mid-execution, or context compaction losing progress. If you need workflow orchestration or multi-agent coordination, the tools above may be a better fit — or complement pi-tasks.

## Install

```sh
pi install npm:pi-tasks
```

For Oh My Pi (`omp`):

```sh
omp install pi-tasks
```

Equivalent explicit plugin command:

```sh
omp plugin install pi-tasks
```

Oh My Pi's `--scope project` flag is for marketplace refs such as
`name@marketplace`; it is ignored for npm package specs like `pi-tasks`.

For local development:

```sh
pi install ./
omp plugin install ./
```

## How it works

```
task_plan → ordered steps with acceptance criteria
    ↓
task_focus → agent sees exactly what's in scope
    ↓
task_update → step-by-step execution with evidence lock
    ↓
task_evidence → attach proof before marking done
    ↓
task_complete → only succeeds when all gates pass
```

Fresh sessions expose only `task_plan` and `task_resume`; after a persisted task is created or restored, pi-tasks activates the available task controls. Explicit Pi tool allowlists, exclusions, and `noTools` remain ceilings, and unrelated active tools are preserved. The user gets `/tasks`. Everything persists in Pi's session tree.

### Oh My Pi support

Oh My Pi discovers extension packages through the same manifest shape:

```json
{
  "pi": {
    "extensions": ["./dist/index.js"]
  }
}
```

No separate `omp` manifest is required. `pi-tasks` uses the Pi-native APIs that
Oh My Pi exposes: `registerTool`, `registerCommand`, `appendEntry`,
`ctx.sessionManager.getBranch()`, `ctx.ui.setStatus`, `ctx.ui.setWidget`, and
the `session_start`, `session_tree`, and `session_before_compact` lifecycle
events.

Because Oh My Pi renders model-facing tool guidance from `description` and
`parameters`, the initial `task_plan` and `task_resume` entrypoints mirror
their critical guidance into descriptions. Lazily activated controls keep only
compact descriptions so native Pi can add them without active-only prompt
metadata.

## Agent Tools

| Tool | Purpose |
|------|---------|
| `task_plan` | Create a task with objectives, criteria, and ordered steps |
| `task_next` | One-step guidance for weak/small-context models |
| `task_focus` | What work is in scope right now |
| `task_resume` | Recover state after compaction or session switch |
| `task_checkpoint` | Save a durable snapshot for compaction resilience |
| `task_granularity_check` | Verify a step is truly atomic |
| `task_decompose` | Break non-atomic steps into child steps |
| `task_list` | List tasks with optional filtering |
| `task_update` | Advance steps, record activity, flag scope drift |
| `task_evidence` | Attach verification evidence to steps/criteria |
| `task_decision` | Record explicit user decisions |
| `task_complete` | Close a task (only if all gates pass) |

### Recovery contracts

- Decomposition stops at depth 4. A still-non-atomic step then recommends an explicit `task_update` blocker so its remaining scope can be planned as a flat successor; pi-tasks never marks it done or creates the successor automatically.
- Evidence fields expose the same limits enforced by the reducer: summaries 500 characters, observed output 1,000, and each reference/source/command 300. Retry templates preserve valid values and replace invalid over-limit values with explicit placeholders.
- `task_update.scope` requires `activity`; `scope_change` and `off_plan` also require `scope_reason`. Missing fields return a targeted `task_update` recovery using the public snake_case parameter names.
- Plan quality still rejects broad or compound actions, but action-like filename segments such as `fixtures/fix.json`, `update.json`, and `then.json` are treated as paths rather than instructions.


## Completion Gates

`task_complete` rejects when:

- No evidence exists
- Any ordered plan step is still active or pending
- Required criteria are not satisfied
- A criterion is satisfied without evidence
- Unresolved blockers remain
- Unresolved scope drift warnings remain
- All evidence is only `not_verified`
- Linked failing step/criterion evidence remains unresolved by a later passing `supersedes` rerun

Forced completion requires `force_with_reason` and produces a low-confidence warning.

When a rerun passes after an honest failed gate, record the passing `task_evidence`
with `supersedes: ["<failed evidence id>"]` and the same linked `step_ids` /
`criterion_ids`; the failed evidence remains in lineage but no longer blocks
completion.

## Token Efficiency

Normal tool results return only the compact resume contract needed for the next action — not the full task state.

```text
# Compact defaults during work:
task_next
task_resume
/tasks

# Detailed view only when debugging:
/tasks detail
task_list include_evidence=true
```

## Custom task UI

pi-tasks publishes a versioned state snapshot after restoring its default widget
and after every successful task mutation. Other Pi extensions can subscribe
without importing or patching pi-tasks internals:

```ts
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  TASK_STATE_EVENT,
  type TaskStateEvent,
} from "pi-tasks";

export default function customTaskUi(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let latest: TaskStateEvent | undefined;

  const render = () => {
    if (!ctx || !latest) return;
    const active = latest.state.activeTaskId
      ? latest.state.tasks[latest.state.activeTaskId]
      : undefined;
    ctx.ui.setWidget(
      latest.widgetId,
      active ? [`Custom task: ${active.id} ${active.title}`] : undefined,
      { placement: "aboveEditor" },
    );
  };
  const attach = (nextCtx: ExtensionContext) => {
    ctx = nextCtx;
    render();
  };

  pi.on("session_start", (_event, nextCtx) => attach(nextCtx));
  pi.on("session_tree", (_event, nextCtx) => attach(nextCtx));
  pi.on("session_shutdown", () => {
    ctx = undefined;
    latest = undefined;
  });
  pi.events.on(TASK_STATE_EVENT, (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      (value as { version?: unknown }).version !== 1
    ) return;
    latest = value as TaskStateEvent;
    render();
  });
}
```

Event contract:

- name: `pi-tasks:state` (`TASK_STATE_EVENT`);
- payload version: `1`;
- reasons: `session_start`, `session_tree`, or `task_mutation`;
- `widgetId`: stable default widget key, currently `pi-tasks`;
- `state`: structured-cloned task snapshot with event history omitted.

The default widget is installed before publication, so a synchronous subscriber
may replace it through the supported widget key. With no subscriber, existing
pi-tasks UI behavior is unchanged. Consumer mutations affect only their cloned
snapshot, never runtime task state. Payloads can include task text, decisions,
blockers, and evidence references; custom UI extensions should keep them local.

## Technical Details

### Capabilities

- Typed task, acceptance criterion, evidence, decision, blocker, and event model
- Pure reducer with transition validation and evidence-before-completion enforcement
- Ordered plan steps; agents must complete or skip the current step before advancing
- Step-level contracts with expected output, linked criteria, required evidence, and allowed actions
- Plan quality gate rejects vague, unverifiable, or over-broad atomic steps
- Stricter atomic scoring rejects compound wording (`and`, `then`, `並且`, `然後`)
- Recursive decomposition gate for non-atomic steps, with explicit blocker recovery at depth 4
- Step-scoped evidence through `task_evidence.step_ids`
- Current-step evidence lock unless explicit `override_reason` is supplied
- Evidence quality gate: traceable, reproducible, with artifact references
- Evidence budget gate with schema-visible limits and bounded retry templates
- Tool rejections include structured recovery details and targeted correction before `task_resume` guidance
- `task_next` one-step weak-model contract with mode, current-step lock, recommended tool, blocked tools, minimum params
- Scope drift recording for `scope_change` and `off_plan` activity
- Derived progress from completed steps, satisfied criteria, and evidence
- Duplicate evidence detection
- Branch-aware persistence via Pi custom entries (`pi-tasks:event`)
- Session replay from `ctx.sessionManager.getBranch()` on `session_start` and `session_tree`
- Compaction snapshot hook via `session_before_compact`
- Compact status bar and above-editor widget
- Oh My Pi-compatible extension manifest, with critical entrypoint guidance preserved in descriptions for hosts that ignore custom `promptSnippet`/`promptGuidelines` fields

### Verification

Local verification suite:

- `PI_SDK_ROOT=/path/to/@earendil-works/pi-coding-agent npm run release:check` (typecheck + lint + unit/native tests + build + import smoke + pack + audit)
- Real Pi dogfood most recently passed on 2026-10-14.

Dogfood coverage includes: task lifecycle, evidence enforcement and bounded retry recovery, ordered step rejection, path-token plan quality, maximum-depth blocker recovery, targeted scope recovery, recursive decomposition, compaction-safe resume, duplicate evidence detection, decision/blocker rendering, forked-session replay, live `/tasks detail`, clean `/quit`, tarball install, and English/Traditional Chinese weak-model smoke.

## Documentation

- [Product Plan](docs/PRODUCT_PLAN.md) — positioning, scope, research, and `/goal` boundary
- [Implementation Specification](docs/IMPLEMENTATION_SPEC.md) — data contracts, reducer rules, tool contracts, TUI spec
- [Dogfood Checklist](docs/DOGFOOD.md) — real Pi dogfood scenarios and status
- [Weak-Model Prompts](docs/dogfood-prompts/) — English and Traditional Chinese validation prompts
- [Release Process](docs/RELEASE_PROCESS.md) — gates required before publishing

## License

MIT
