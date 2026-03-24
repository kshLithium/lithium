import { useEffect } from "react";
import type { RuntimeAppState } from "../shared/types";
import { buildOnboardingChecklist } from "./app-utils";

type OnboardingPanelProps = {
  appState: RuntimeAppState;
  projectReady: boolean;
  onDismiss: () => void;
  onOpenWorkspace: () => void;
};

export function OnboardingPanel(props: OnboardingPanelProps) {
  const checklist = buildOnboardingChecklist(props.appState, props.projectReady);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onDismiss();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [props.onDismiss]);

  return (
    <div className="startup-guide-backdrop" role="presentation">
      <section
        aria-describedby="startup-guide-description"
        aria-labelledby="startup-guide-title"
        aria-modal="true"
        className="startup-guide"
        role="dialog"
      >
        <div className="startup-guide-header">
          <div>
            <div className="startup-guide-eyebrow">First launch</div>
            <h1 id="startup-guide-title">Set up Lithium once, then stay in one session.</h1>
          </div>
          <button
            aria-label="Close setup guide"
            className="startup-guide-close"
            onClick={props.onDismiss}
            type="button"
          >
            ×
          </button>
        </div>

        <p className="startup-guide-description" id="startup-guide-description">
          Lithium keeps code, runs, paper work, and memory in one local workspace. The only
          setup you really need is signing the strategist into ChatGPT once, letting that browser
          session get reused, and then opening a folder when you want to work inside an existing
          directory.
        </p>

        <div className="startup-guide-grid">
          {checklist.map((item, index) => (
            <article className="startup-card" key={item.id}>
              <div className="startup-card-topline">
                <span className="startup-card-index">0{index + 1}</span>
                <span className={item.status === "ready" ? "startup-badge ready" : "startup-badge action"}>
                  {item.status === "ready" ? "Ready" : "Needs setup"}
                </span>
              </div>
              <h2>{item.title}</h2>
              <p>{item.detail}</p>
              {item.hint ? <div className="startup-hint">{item.hint}</div> : null}
            </article>
          ))}
        </div>

        <div className="startup-guide-paths single">
          <div className="startup-path-card">
            <div className="startup-path-label">First strategist run</div>
            <div className="startup-path-title">ChatGPT Pro login</div>
            <p>
              On the first strategist run, Lithium will open a visible browser and guide the
              ChatGPT Pro login flow. After that first successful run, later strategist calls
              should keep reusing the saved browser session quietly in the background without
              opening another visible window.
            </p>
          </div>
        </div>

        <div className="startup-guide-footer">
          <div className="startup-guide-note">
            If you install Chrome later, restart the app so setup can be re-checked.
          </div>
          <div className="startup-guide-actions">
            <button className="toolbar-pill" onClick={props.onDismiss} type="button">
              Continue later
            </button>
            <button className="toolbar-pill" onClick={props.onOpenWorkspace} type="button">
              {props.appState.selectedWorkspacePath ? "Choose another folder" : "Choose folder"}
            </button>
            <button className="toolbar-pill active" onClick={props.onDismiss} type="button">
              Start using Lithium
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
