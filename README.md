# Lithium

Lithium is an Electron desktop prototype for running a local research and build loop in one workspace.

It keeps strategist output, builder runs, files, paper work, terminal state, and durable project memory under the same workspace so the app can resume where it left off.

## Stack

- Electron for the desktop shell
- Vite + React 19 for the renderer
- TypeScript across main, renderer, shared, and mobile surfaces
- Vitest for unit and integration coverage
- `codex` and strategist runners for the research loop

## What it includes

- A desktop app built with Electron, Vite, React, and TypeScript
- A main-process service layer that orchestrates strategist, builder, automation, terminal, and remote workspace flows
- A renderer workbench for chat, code, memory, paper editing, PDF preview, and run inspection
- A lightweight mobile companion client for remote monitoring and control

## Repository layout

- `src/main`: Electron entrypoints and the service layer
- `src/renderer`: Desktop UI and workbench surfaces
- `src/mobile-client`: Mobile web client
- `src/shared`: Cross-process types and shared helpers
- `scripts`: Dev utilities, smoke flows, and README screenshot capture helpers
- `docs/readme`: README screenshots

## Some screens

![Lithium chat](./docs/readme/hero-chat.png)

![Lithium code](./docs/readme/code-workbench.png)

![Lithium paper](./docs/readme/paper-workbench.png)

## Requirements

- Node.js and npm
- Chrome or Chromium if you use the strategist browser flow
- `codex` on your `PATH` for builder and router execution
- `npx` on your `PATH` for Oracle-based strategist runs
- `tectonic` on your `PATH` if you want to compile `paper/main.tex`

## Development

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run dev:full      # desktop app + mobile client
npm run typecheck
npm test
npm run build
npm run check:release
npm run package:dir
npm run dev:packaged
npm run simulate:smoke
```

To refresh the screenshots in this README:

```bash
npm run build
npm run capture:readme
```

## Workspace state

Lithium stores workspace-local state in `.lithium/`, including:

- project metadata and thread state
- strategist decisions and builder runs
- automation records and checkpoints
- terminal transcripts
- context bundles and memory files

This means the app can rebuild its view of the project from the workspace itself instead of relying on a separate server.

## Packaging and verification

- `npm run build` builds `dist`, `dist-electron`, and `dist-mobile`
- `npm run package:dir` creates a packaged desktop app in `release/`
- `npm run dev:packaged` builds and launches the packaged app
- `npm test` is the quickest full regression pass after code changes

## Current focus

Lithium is still a prototype, but the codebase is now organized around a few practical rules:

- command runners keep full logs on disk while capping in-memory capture
- heavyweight renderer panels load lazily instead of inflating the first paint
- project snapshots read persisted records in bounded parallel batches instead of one file at a time
- shared file-system helpers remove repeated output-file setup and stream handling
- renderer state that tends to drift, like thread seen markers, lives in dedicated hooks

There are still unfinished edges, but the core loops are covered by a fairly broad Vitest suite.

## License

MIT
