# Single-User Local Golden Path Proof

Date: 2026-04-03

## Current Read

- Current product stage: advanced prototype with working CLI, resident orchestration, and a broad passing test base.
- Key gap: there is still no small proof artifact showing that one user can start locally and leave durable evidence behind in the workspace.
- Selected next research outcome: single-user local golden-path proof artifact.
- Most important hypothesis or product risk: if first boot does not immediately create recoverable `.lithium/` state, the local-first loop is not trustworthy enough to validate later automation steps.
- Smallest validating experiment: boot a blank workspace through `AppService.initProject` and assert that `.lithium/project.json`, `.lithium/memory/project-memory.json`, `.lithium/context/current-context.md`, and `.lithium/activity.log` are persisted with default thread and project-memory evidence.
- Acceptance criteria:
  - one focused integration test passes locally
  - the booted workspace contains durable `.lithium/` evidence files
  - the context bundle includes project memory and the active thread
- Concrete next bounded move after this step: add one follow-on smoke test that starts from a booted workspace and proves the first user request or automation-session start produces a durable handoff/request artifact under `.lithium/`

## Implemented Validating Unit

- Added `boots a blank workspace into a recoverable local state` in [src/main/services/app-service.test.ts](/Users/rubidium/project/lithium/src/main/services/app-service.test.ts)
- This test exercises the user-facing workspace boot path and checks that the persisted local state is both present and legible

## Verification

- `npx vitest run src/main/services/app-service.test.ts -t "boots a blank workspace into a recoverable local state"`  
  Result: passed on 2026-04-03 with 1 file passed, 1 test passed, 43 skipped
