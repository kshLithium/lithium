# Lithium

Lithium is a local-first CLI for running an automation-heavy research loop from one main chat.

## Philosophy

- Chat is the front door.
- Workspace state should live with the workspace.
- Research, execution, and memory should feel like one loop instead of separate tools.
- The tool should stay lightweight instead of growing side tools again.

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

Lithium accepts natural-language chat input by default. Use these commands only for precise control:

```text
:help
:workspace <path>
:threads
:thread new [title]
:thread use <id|index>
:attach <path...>
:signin
:status
:exit
```

Route overrides still work in chat:

```text
/research ...
/build ...
/mixed ...
/plan ...
```

## Development

```bash
npm test
npm run typecheck
npm run build
```

## Notes

- Lithium stores workspace state in `.lithium/` inside the selected folder.
- CLI settings live in `~/.lithium/settings.json`.
- `:signin` prepares the reusable strategist browser session for ChatGPT/Oracle-backed research turns.

## License

MIT
