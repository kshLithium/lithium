import { AppService } from "../src/main/services/app-service.ts";

process.env.LITHIUM_ORACLE_VISIBLE ??= "1";

const workspacePath = process.env.LITHIUM_WORKSPACE ?? process.cwd();
const app = new AppService(workspacePath);

const strategistPrompt = [
  "This is a live Lithium smoke simulation.",
  "Return a safe no-op builder task.",
  "The NEXT_TASK must instruct Codex to make no file changes and return exactly these lines:",
  "SUMMARY: smoke test only",
  "FILES: none",
  "RESULT: success"
].join(" ");

console.log("STEP initProject");
await app.initProject(workspacePath);

console.log("STEP consultStrategist");
const strategistSnapshot = await app.consultStrategist({
  workspacePath,
  prompt: strategistPrompt
}, {
  strategistSessionReady: false
});
console.log(
  JSON.stringify(
    {
      decisionId: strategistSnapshot.latestDecision?.id,
      summary: strategistSnapshot.latestDecision?.summary,
      nextTask: strategistSnapshot.latestDecision?.nextTask
    },
    null,
    2
  )
);

const nextTask = strategistSnapshot.latestDecision?.nextTask ?? "";
if (!nextTask.trim()) {
  throw new Error("Strategist did not produce a NEXT_TASK.");
}

console.log("STEP runBuilderTask");
const builderSnapshot = await app.runBuilderTask({
  workspacePath,
  prompt: nextTask
});
console.log(
  JSON.stringify(
    {
      runId: builderSnapshot.latestRun?.id,
      status: builderSnapshot.latestRun?.status,
      finalMessage: builderSnapshot.latestRun?.finalMessage
    },
    null,
    2
  )
);

console.log("STEP updateManuscript");
const paperSnapshot = await app.updateManuscript(workspacePath);
console.log(
  JSON.stringify(
    {
      manuscriptPath: paperSnapshot.manuscript?.path,
      memoryUpdatedAt: paperSnapshot.memory?.updatedAt
    },
    null,
    2
  )
);
