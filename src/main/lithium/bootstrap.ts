import { CodexRunner } from "../services/codex-runner";
import { OracleRunner } from "../services/oracle-runner";
import { ContextBuilder } from "./context-builder";
import { WorkspaceDaemon } from "./daemon";
import { Dispatcher } from "./dispatcher";
import { ArtifactStore } from "./artifact-store";
import { PolicyEngine } from "./policy-engine";
import { BuilderProvider } from "./providers/builder-provider";
import { EvaluatorProvider } from "./providers/evaluator-provider";
import { ExperimentProvider } from "./providers/experiment-provider";
import { StrategistProvider } from "./providers/strategist-provider";
import { RunManager } from "./run-manager";
import { SourceIngest } from "./source-ingest";
import { ResearchStore } from "./store";
import { WorkerLeaseManager } from "./worker-lease-manager";

export function createWorkspaceDaemon(workspacePath: string) {
  const store = new ResearchStore();
  const artifactStore = new ArtifactStore();
  const policy = new PolicyEngine();
  const sourceIngest = new SourceIngest({
    store,
    artifactStore
  });
  const leaseManager = new WorkerLeaseManager();
  const contextBuilder = new ContextBuilder({
    store,
    sourceIngest,
    artifactStore
  });
  const providers = [
    new StrategistProvider({
      oracleRunner: new OracleRunner(),
      artifactStore,
      store
    }),
    new BuilderProvider({
      codexRunner: new CodexRunner(),
      artifactStore,
      store,
      leaseManager
    }),
    new ExperimentProvider({
      artifactStore,
      leaseManager
    }),
    new EvaluatorProvider({
      artifactStore
    })
  ];
  const dispatcher = new Dispatcher({
    providers,
    contextBuilder
  });
  const runManager = new RunManager({
    store,
    policy,
    sourceIngest,
    leaseManager
  });

  return new WorkspaceDaemon(workspacePath, {
    store,
    runManager,
    policy,
    dispatcher
  });
}
