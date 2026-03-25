# Lithium

Lithium is a local-first desktop app for running an automation-heavy research loop in one workspace.

The basic idea is simple: keep the conversation, memory, files, runs, and paper trail together so the app can pick the thread back up without a separate backend trying to remember everything for you.

## Philosophy

- Chat is the front door.
- Workspace state should live with the workspace.
- Research, execution, memory, and writing should feel like one loop instead of four different tools.
- The app should stay useful even when the internals are still rough around the edges.

## Main View

![Lithium chat](./docs/readme/hero-chat.png)

## Development

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm test
npm run typecheck
npm run build
```

## Notes

- Lithium stores project state in `.lithium/` inside the workspace.
- The app is still a prototype, but it is organized around resuming real work instead of demo-only flows.

## License

MIT
