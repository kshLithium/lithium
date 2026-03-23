import type { DecisionRecord, RunRecord, ThreadRecord } from "../shared/types";
import type { MemoryDraft } from "./app-types";
import { basenamePath, handoffItems, summarizeContextPack } from "./app-utils";

type ContextWorkbenchProps = {
  activeThread: ThreadRecord | null;
  busy: boolean;
  contextBundlePreview: string;
  latestDecision: DecisionRecord | null;
  latestRun: RunRecord | null;
  memoryDraft: MemoryDraft;
  onChangeMemoryField: (field: keyof MemoryDraft, value: string) => void;
  onChangeThreadMemory: (value: string) => void;
  onSave: () => void;
  projectReady: boolean;
  sessionSummary: string;
  threadMemory: string;
};

export function ContextWorkbench(props: ContextWorkbenchProps) {
  const packPreview = summarizeContextPack(props.contextBundlePreview);

  if (!props.projectReady) {
    return (
      <section className="surface-panel memory-surface">
        <div className="surface-main">
          <div className="surface-main-header">
            <div>
              <div className="drawer-title">Context</div>
              <div className="drawer-subtitle">
                Project memory, thread memory, and structured handoffs appear after the first research action.
              </div>
            </div>
          </div>

          <div className="empty-state">
            Start a research chat to create the session state for this folder.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="surface-panel memory-surface">
      <div className="surface-main">
        <div className="surface-main-header">
          <div>
            <div className="drawer-title">Context</div>
            <div className="drawer-subtitle">
              Persist project memory, thread memory, and the machine-readable handoff state in one place.
            </div>
          </div>
          <button
            className="composer-action"
            disabled={props.busy || !props.projectReady}
            onClick={props.onSave}
            type="button"
          >
            Save
          </button>
        </div>

        <div className="context-layout">
          <div className="context-column">
            <section className="context-section">
              <div className="context-section-header">
                <div className="drawer-title">Project Memory</div>
                <div className="drawer-subtitle">Long-lived instructions shared across every thread.</div>
              </div>

              <div className="memory-form-grid">
                <label className="field">
                  <span>Project brief</span>
                  <textarea
                    value={props.memoryDraft.projectBrief}
                    onChange={(event) => props.onChangeMemoryField("projectBrief", event.target.value)}
                  />
                </label>

                <label className="field">
                  <span>Research goal</span>
                  <textarea
                    value={props.memoryDraft.researchGoal}
                    onChange={(event) => props.onChangeMemoryField("researchGoal", event.target.value)}
                  />
                </label>

                <label className="field">
                  <span>Open questions</span>
                  <textarea
                    value={props.memoryDraft.openQuestions}
                    onChange={(event) => props.onChangeMemoryField("openQuestions", event.target.value)}
                  />
                </label>

                <label className="field">
                  <span>Active hypotheses</span>
                  <textarea
                    value={props.memoryDraft.activeHypotheses}
                    onChange={(event) => props.onChangeMemoryField("activeHypotheses", event.target.value)}
                  />
                </label>
              </div>
            </section>

            <section className="context-section">
              <div className="context-section-header">
                <div>
                  <div className="drawer-title">Thread Memory</div>
                  <div className="drawer-subtitle">
                    Manual notes for the active research lane. This is separate from the auto summary.
                  </div>
                </div>
                <div className="context-thread-meta">{props.activeThread?.title ?? "No active thread"}</div>
              </div>

              <label className="field">
                <span>Working memory</span>
                <textarea
                  className="context-thread-textarea"
                  value={props.threadMemory}
                  onChange={(event) => props.onChangeThreadMemory(event.target.value)}
                  placeholder="Capture assumptions, active plan fragments, or constraints for this thread."
                />
              </label>

              <div className="memory-summary-grid context-summary-grid">
                <div className="memory-card">
                  <div className="memory-card-label">Auto summary</div>
                  <div className="memory-card-value">
                    {props.activeThread?.summary || "No automatic thread summary yet."}
                  </div>
                </div>
                <div className="memory-card">
                  <div className="memory-card-label">Session</div>
                  <div className="memory-card-value">
                    {props.sessionSummary || "No session summary yet."}
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div className="context-column">
            <section className="context-section">
              <div className="context-section-header">
                <div>
                  <div className="drawer-title">Structured Handoffs</div>
                  <div className="drawer-subtitle">
                    The latest strategist and builder cards that downstream lanes actually read.
                  </div>
                </div>
              </div>

              <div className="context-handoff-grid">
                <HandoffCard record={props.latestDecision} title="Strategist" />
                <HandoffCard record={props.latestRun} title="Builder" />
              </div>
            </section>

            <section className="context-section">
              <div className="context-section-header">
                <div>
                  <div className="drawer-title">Current Context Pack</div>
                  <div className="drawer-subtitle">
                    Deterministic bundle assembled before the next model call.
                  </div>
                </div>
                <div className="context-thread-meta">current-context.md</div>
              </div>

              <div className="context-pack-preview">
                <div className="context-pack-meta">.lithium/context/current-context.md</div>
                <pre className="context-pack-body">
                  {packPreview || "No context pack has been generated yet."}
                </pre>
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}

type HandoffRecord = DecisionRecord | RunRecord | null;

function HandoffCard(props: { record: HandoffRecord; title: string }) {
  const handoff = props.record?.handoff ?? null;
  const items = handoffItems(handoff);
  const packLabel = props.record?.contextPackPath ? basenamePath(props.record.contextPackPath) : "No pack yet";
  const timestamp = props.record
    ? "endedAt" in props.record
      ? props.record.endedAt
      : props.record.createdAt
    : "";

  return (
    <article className="context-handoff-card">
      <div className="context-card-header">
        <div>
          <div className="drawer-title">{props.title}</div>
          <div className="drawer-subtitle">{packLabel}</div>
        </div>
        <div className="context-thread-meta">{timestamp ? formatTimestamp(timestamp) : "No run yet"}</div>
      </div>

      {handoff ? (
        <>
          <div className="context-card-text">{handoff.summary}</div>
          {handoff.result ? (
            <div className="context-card-detail">
              <span className="memory-card-label">Result</span>
              <div className="memory-card-value">{handoff.result}</div>
            </div>
          ) : null}
          {handoff.rationale ? (
            <div className="context-card-detail">
              <span className="memory-card-label">Rationale</span>
              <div className="memory-card-value">{handoff.rationale}</div>
            </div>
          ) : null}
          {items.length ? (
            <div className="context-chip-stack">
              {items.map((item) => (
                <div key={item.label} className="context-chip-group">
                  <div className="context-chip-label">{item.label}</div>
                  <div className="context-chip-row">
                    {item.values.map((value) => (
                      <span key={`${item.label}:${value}`} className="context-chip">
                        {value}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="context-empty-card">No structured handoff captured yet.</div>
      )}
    </article>
  );
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
