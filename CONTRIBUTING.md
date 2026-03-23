# Contributing

Lithium is a local-first desktop research cockpit. Keep contributions aligned with the product thesis:

- one chat-first research session
- code, paper, and terminal in the same app
- durable state in `.lithium/`, not just chat history

## Development

```bash
npm install
npm run dev
```

## Checks

```bash
npm run typecheck
npm test
npm run build
```

## Packaging

```bash
npm run package:dir
npm run dist:mac
```

## Ground Rules

- Prefer small, reviewable commits.
- Keep renderer logic split by surface or workbench rather than growing `App.tsx`.
- Add or update tests when changing persistence, orchestration, or parsing.
- Do not persist state only in prompts. If a model needs it later, write it into `.lithium/`.
