import { useEffect, useMemo, useState } from "react";
import type {
  BuilderRunInspection,
  ResolvedTheme,
  TerminalConnectionProfile,
  WorkspaceTransportKind
} from "../shared/types";
import { useTerminalWindow } from "./terminal/useTerminalWindow";

type TerminalPanelProps = {
  busy: boolean;
  connectionProfiles: TerminalConnectionProfile[];
  projectReady: boolean;
  suggestedStatus: BuilderRunInspection["suggestedStatus"] | null;
  themeMode: ResolvedTheme;
  threadId?: string;
  workspaceKind: WorkspaceTransportKind;
  workspacePath: string;
  onFinalizeRun: () => void;
  onTerminateRun: () => void;
};

export function TerminalPanel(props: TerminalPanelProps) {
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const selectedProfile = useMemo(
    () => props.connectionProfiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [props.connectionProfiles, selectedProfileId]
  );
  const { hostRef, restartSession, statusLabel, session } = useTerminalWindow({
    projectReady: props.projectReady,
    themeMode: props.themeMode,
    threadId: props.threadId,
    workspacePath: props.workspacePath
  });

  useEffect(() => {
    if (!selectedProfileId) {
      return;
    }

    if (props.connectionProfiles.some((profile) => profile.id === selectedProfileId)) {
      return;
    }

    setSelectedProfileId("");
  }, [props.connectionProfiles, selectedProfileId]);

  return (
    <section className="terminal-panel">
      <div className="terminal-window">
        <div className="terminal-window-body">
          <div className="terminal-toolbar">
            <div className="terminal-toolbar-group">
              <label className="terminal-profile-field">
                <span className="terminal-profile-label">Session</span>
                <select
                  className="terminal-profile-select"
                  onChange={(event) => {
                    setSelectedProfileId(event.target.value);
                  }}
                  value={selectedProfileId}
                >
                  <option value="">{props.workspaceKind === "local" ? "Local shell" : "Workspace shell"}</option>
                  {props.connectionProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>

              <button
                className="toolbar-pill"
                disabled={props.busy || !props.projectReady}
                onClick={() =>
                  void restartSession({
                    bootstrapCommand: selectedProfile?.command
                  })
                }
                type="button"
              >
                {selectedProfile
                  ? "Reconnect with preset"
                  : props.workspaceKind === "local"
                    ? "New local shell"
                    : "New workspace shell"}
              </button>
            </div>

            <div className="terminal-toolbar-copy">
              {selectedProfile?.description ||
                selectedProfile?.command ||
                (props.workspaceKind === "local"
                  ? "Save SSH or container commands in Settings, then reconnect into a fresh terminal session here."
                  : "This workspace already opens a remote shell by default. You can still override it with saved presets here.")}
            </div>
          </div>

          {props.suggestedStatus === "awaiting-finalization" || props.suggestedStatus === "hung" ? (
            <div className="terminal-inline-actions">
              <div className="terminal-inline-actions-group">
                <button
                  className="toolbar-pill warning"
                  disabled={props.busy}
                  onClick={props.onFinalizeRun}
                  type="button"
                >
                  Finalize
                </button>
                <button
                  className="toolbar-pill"
                  disabled={props.busy}
                  onClick={props.onTerminateRun}
                  type="button"
                >
                  Stop Run
                </button>
              </div>
            </div>
          ) : null}

          <div className="terminal-xterm-shell">
            <div ref={hostRef} className="terminal-xterm-host" />
            {!session && statusLabel ? (
              <div className="terminal-window-placeholder">
                {statusLabel === "starting" ? "Opening terminal..." : statusLabel}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
