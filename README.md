# Lithium

Lithium is a local-first CLI for running an objective-first research engine from one terminal.

## Philosophy

- Objectives, branches, work items, evidence, and evaluations are the source of truth.
- Workspace state should live with the workspace.
- Research, execution, evidence capture, and evaluation should feel like one loop.
- Builder edits and experiments should run in isolated worktrees whenever possible.

## Usage

```bash
npm install
npm run build
node dist/cli.cjs [workspacePath]
```

Or run the interactive CLI directly in dev mode:

```bash
npm run dev -- [workspacePath]
```

If no workspace path is provided, Lithium uses the last workspace from `~/.lithium/settings.json`, and falls back to the current directory.

## CLI Commands

Lithium runs in objective-first autopilot mode. Free-form chat is disabled.

```text
:help
:workspace <path>
:objective list
:objective new <goal>
:objective use <id>
:run start
:run pause
:run resume
:run stop
:attach <path...>
:signin
:status
:queue
:evidence
:exit
```

## Development

```bash
npm test
npm run typecheck
npm run build
```

## Notes

- Lithium stores workspace state in `.lithium/` inside the selected folder.
- Active research state lives under `.lithium/research/`.
- CLI settings live in `~/.lithium/settings.json`.
- `:signin` prepares the reusable strategist browser session for Oracle-backed planner and research work.

## License

MIT
