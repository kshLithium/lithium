# Single-User Local Golden Path Proof

Date: 2026-04-08

## Current Read

- Current product stage: V5 reliability-focused local research orchestrator with a workspace daemon, typed state projections, and transactional audit events.
- Key gap addressed here: prove that a single user can boot a blank workspace, create an objective through the daemon RPC surface, and leave durable `.lithium/` state behind.
- Selected outcome: a small local-first proof artifact tied to the real daemon/bootstrap path.
- Most important hypothesis or product risk: if first boot does not create recoverable `.lithium/state`, `.lithium/runtime`, and artifact directories, the local-first contract is still too weak to trust later autonomous runs.
- Smallest validating experiment: boot a blank workspace through `createWorkspaceDaemon(...)`, create an objective over the local socket, and assert that `.lithium/state/research.db` plus runtime state are durable and queryable.
- Acceptance criteria:
  - one focused integration test passes locally
  - the booted workspace contains durable `.lithium/` evidence directories
  - the booted state contains an active objective and readable status snapshot
- Concrete next bounded move after this step: extend the daemon integration coverage to `run start -> pause -> resume -> stop` and assert that interrupted builder work leaves patch artifacts and a clean leased worktree

## Implemented Validating Unit

- Added coverage around the real daemon RPC surface in [src/main/lithium/daemon.integration.test.ts](/Users/rubidium/project/lithium/src/main/lithium/daemon.integration.test.ts)
- This test exercises the workspace boot path through `createWorkspaceDaemon(...)`, creates an objective over the local socket, and checks that the objective is visible through both `objective.list` and `status.snapshot`
- Durable evidence produced by this path now lives under:
  - `.lithium/state/research.db`
  - `.lithium/runtime/daemon.sock`
  - `.lithium/runtime/daemon.pid`
  - `.lithium/runtime/daemon.log`

## Verification

- `npx vitest run src/main/lithium/daemon.integration.test.ts`
- `npm run typecheck`
- `npm test`
