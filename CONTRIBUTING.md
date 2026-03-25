# Contributing

Lithium is a local-first desktop research app. Keep contributions aligned with the product thesis:

- one chat-first research session
- automation research through the main chat
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
- Keep renderer logic centered on the main chat instead of bringing back side panels or manual editors.
- Add or update tests when changing persistence, orchestration, or parsing.
- Do not persist state only in prompts. If a model needs it later, write it into `.lithium/`.
- Keep root docs minimal. Standard repo files can stay in the root, but extra docs and assets should live under [`docs/`](/Users/rubidium/project/lithium/docs).
