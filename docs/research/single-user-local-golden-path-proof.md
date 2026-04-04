# Single-User Local Golden Path Proof

Date: 2026-04-03

## Current Read

- Current product stage: objective-first research prototype with a working autopilot CLI and a broad passing test base.
- Key gap: there is still no small proof artifact showing that one user can start locally and leave durable evidence behind in the workspace.
- Selected next research outcome: single-user local golden-path proof artifact.
- Most important hypothesis or product risk: if first boot does not immediately create recoverable `.lithium/` state, the local-first loop is not trustworthy enough to validate later automation steps.
- Smallest validating experiment: boot a blank workspace through `ResearchService.initWorkspace` and assert that `.lithium/project.json`, `.lithium/research/`, and `.lithium/activity.log` are persisted with a recoverable default objective graph.
- Acceptance criteria:
  - one focused integration test passes locally
  - the booted workspace contains durable `.lithium/` evidence files
  - the booted state contains an active objective and projection
- Concrete next bounded move after this step: add one follow-on smoke test that starts from a booted workspace and proves the first run start produces durable research state and evidence artifacts under `.lithium/research/`

## Implemented Validating Unit

- Added coverage around the user-facing boot and run path in [src/main/services/research-service.test.ts](/Users/rubidium/project/lithium/src/main/services/research-service.test.ts)
- This test coverage exercises the objective-first workspace boot path and checks that persisted local state is present and legible

## Verification

- `npx vitest run src/main/services/research-service.test.ts`  
  Result: keep this updated with the latest local verification run when the proof is refreshed
