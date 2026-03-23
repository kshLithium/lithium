import { AppService } from "../src/main/services/app-service.ts";

const workspacePath = process.env.LITHIUM_WORKSPACE ?? process.cwd();
const app = new AppService(workspacePath);

console.log("STEP initProject");
const initial = await app.initProject(workspacePath);
console.log(
  JSON.stringify(
    {
      activeThreadId: initial.activeThreadId,
      activeThreadTitle: initial.activeThread?.title,
      threadCount: initial.threads.length
    },
    null,
    2
  )
);

console.log("STEP createThread");
const second = await app.createThread({
  workspacePath,
  title: "Second thread"
});
console.log(
  JSON.stringify(
    {
      activeThreadId: second.activeThreadId,
      activeThreadTitle: second.activeThread?.title,
      threadCount: second.threads.length
    },
    null,
    2
  )
);

console.log("STEP selectThread");
const restored = await app.selectThread({
  workspacePath,
  threadId: initial.activeThreadId!
});
console.log(
  JSON.stringify(
    {
      activeThreadId: restored.activeThreadId,
      activeThreadTitle: restored.activeThread?.title,
      threadCount: restored.threads.length
    },
    null,
    2
  )
);
