# Lithium

Lithium is a local-first autonomous research engine with a workspace-scoped daemon, event log, projection store, artifact memory, and provider-backed execution pipeline.

## V4 Highlights

- `lithiumd`-style runtime through `lithium daemon start|stop|status`
- workspace-local RPC over `.lithium/runtime/daemon.sock`
- append-only event log with projection tables in `.lithium/state/research.db`
- retrieval-oriented source ingest with chunk indexing under `.lithium/index`
- builder, experimenter, evaluator, and browser-backed strategist providers behind task contracts
- reducer-driven branch evaluation and patch promotion without an `arbitrate_branch` task

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
lithium run start|pause|resume|stop [--workspace <path>] [--objective <id>]
lithium run watch [--workspace <path>] [--interval <ms>]
lithium source add <path-or-url...> [--workspace <path>] [--objective <id>] [--branch <id>]
lithium status [--workspace <path>] [--json]
lithium workspace reset|archive [--workspace <path>]
```

## Workspace Layout

Lithium stores all state inside `.lithium/` in the selected workspace:

- `.lithium/state/research.db`
- `.lithium/runtime/*`
- `.lithium/artifacts/*`
- `.lithium/index/*`

Legacy V3 workspaces are intentionally not migrated in place. Use `lithium workspace archive` or `lithium workspace reset` before starting the daemon in an older workspace.

## Development

```bash
npm run typecheck
npm test
npm run build
```
