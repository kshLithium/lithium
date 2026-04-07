# Lithium

Lithium is a local-first autonomous research orchestrator with a workspace-scoped daemon, typed projection store, transactional audit log, artifact memory, and provider-backed execution pipeline.

## V5 Highlights

- workspace-local daemon lifecycle through `lithium daemon start|stop|status`
- workspace-local RPC over `.lithium/runtime/daemon.sock`
- typed projections plus a transactional audit log in `.lithium/state/research.db`
- exact run targeting for `lithium run stop --run <id>` with hard pause/resume semantics
- greedy task reservation that enforces executor capacity, branch mutation exclusion, and evaluation barriers
- objective-scoped sources linked into branches through `SourceLink` records and BM25-style retrieval under `.lithium/index`
- strict structured-output parsing for strategist, builder, and evaluator providers with retry-or-fail handling
- explicit `build_change -> verify_change/run_experiment -> evaluate_branch -> promote_patch` flow instead of implicit promotion side effects

## CLI

```bash
npm install
npm run build
node dist/cli.cjs daemon start --workspace /path/to/workspace
```

Core commands:

```text
lithium daemon start|stop|status [--workspace <path>] [--foreground]
lithium objective create <goal> [--workspace <path>] [--title <title>] [--success <criterion> ...]
lithium objective list|show [objectiveId] [--workspace <path>]
lithium run start|pause|resume [--workspace <path>] [--objective <id>]
lithium run stop [--workspace <path>] [--objective <id>] [--run <id>]
lithium run watch [--workspace <path>] [--interval <ms>]
lithium source add <path-or-url...> [--workspace <path>] [--objective <id>] [--branch <id>]
lithium status [--workspace <path>] [--json]
lithium workspace reset|archive [--workspace <path>]
```

`run pause` is a hard pause. Lithium interrupts active handles for the targeted run, snapshots builder patches when tracked changes exist, restores the leased worktree, and returns interrupted tasks to `pending` before moving the run to `paused`.

## Runtime Model

Lithium keeps the execution plane and research plane separate:

- research records: objective, branch, source, source link, finding, experiment spec, experiment run, evaluation decision, promotion record
- orchestration records: run, task, worker run, audit event

Only builder tasks get write-capable worktree leases. Verification, experiment, and evaluator tasks run under read-only contracts, and tracked file mutations during those phases are treated as policy violations.

Evaluation is layered:

1. deterministic gate for exit code, timeout, required metrics, and contract violations
2. quantitative comparator against the objective baseline experiment when available
3. LLM interpretation for branch-level reasoning, follow-up steps, and verdicts

## Workspace Layout

Lithium stores all state inside `.lithium/` in the selected workspace:

- `.lithium/state/research.db`
- `.lithium/runtime/daemon.sock`
- `.lithium/runtime/daemon.pid`
- `.lithium/runtime/daemon.log`
- `.lithium/runtime/leases/*`
- `.lithium/runtime/temp-envs/*`
- `.lithium/artifacts/worker-runs/*`
- `.lithium/artifacts/strategist/*`
- `.lithium/artifacts/evaluator/*`
- `.lithium/artifacts/experiments/*`
- `.lithium/artifacts/patches/*`
- `.lithium/artifacts/worktrees/*`
- `.lithium/artifacts/source-bodies/*`
- `.lithium/artifacts/source-texts/*`
- `.lithium/artifacts/attachments/*`
- `.lithium/index/source-chunks/*`

Lithium V5 does not migrate legacy workspace state in place. Use `lithium workspace archive` or `lithium workspace reset` before starting the daemon in an older workspace.

## Operator Settings

Browser-backed strategist recovery is configured through environment variables in `.env.example`.

Model and prompt preferences live in `~/.lithium/settings.json`:

- `oracleModel`
- `oracleThinkingTime`
- `builderModel`
- `builderReasoningEffort`
- `promptLanguage`

## Development

```bash
npm run typecheck
npm test
npm run build
```
