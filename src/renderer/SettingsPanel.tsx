import { useEffect, useState, type ReactNode } from "react";
import type {
  AppSettings,
  AppSettingsUpdate,
  AutomationPromptLanguage,
  DiscordBotRuntimeStatus,
  DiscordBotSettings,
  RemoteWorkspaceProfile,
  RuntimeAppState,
  StrategistBrowserProbeResponse,
  TerminalConnectionProfile,
  ThemePreference
} from "../shared/types";
import { TERMINAL_FEATURE_ENABLED } from "../shared/feature-flags";

type SettingsPanelProps = {
  appState: RuntimeAppState;
  settings: AppSettings;
  onClose: () => void;
  onReopenOnboarding: () => void;
  onStartStrategistSignIn: () => void;
  onRunStrategistProbe: (input: {
    model: "gpt-5.4" | "gpt-5.4-pro";
    reasoningIntensity: "heavy" | "extended";
  }) => void;
  onConnectRemoteWorkspace: (profileId: string) => void | Promise<void>;
  onSyncRemoteWorkspace: () => void | Promise<void>;
  onSetTheme: (themePreference: ThemePreference) => void;
  onUpdateSettings: (update: AppSettingsUpdate) => void | Promise<void>;
  strategistProbeBusy: boolean;
  strategistProbeResult: StrategistBrowserProbeResponse | null;
};

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

const AUTOPILOT_LANGUAGE_OPTIONS: Array<{ value: AutomationPromptLanguage; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" }
];

export function SettingsPanel(props: SettingsPanelProps) {
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileCommand, setNewProfileCommand] = useState("");
  const [newProfileDescription, setNewProfileDescription] = useState("");
  const [newRemoteProfile, setNewRemoteProfile] = useState<RemoteWorkspaceDraft>(() => createEmptyRemoteWorkspaceDraft());
  const [discordBotDraft, setDiscordBotDraft] = useState<DiscordBotDraft>(() =>
    createDiscordBotDraft(props.settings.discordBot)
  );
  const [discordTokenVisible, setDiscordTokenVisible] = useState(false);
  const [discordBotSaving, setDiscordBotSaving] = useState(false);
  const [discordBotError, setDiscordBotError] = useState("");
  const hiddenProbeReady = Boolean(props.appState.oracleChromePath && props.settings.strategistSessionReady);
  const discordBotStatus = props.appState.discordBotStatus;

  useEffect(() => {
    setDiscordBotDraft(createDiscordBotDraft(props.settings.discordBot));
  }, [props.settings.discordBot]);

  const updateProfiles = (profiles: TerminalConnectionProfile[]) => {
    void props.onUpdateSettings({
      terminalConnectionProfiles: profiles
    });
  };

  const updateProfile = (profileId: string, patch: Partial<TerminalConnectionProfile>) => {
    updateProfiles(
      props.settings.terminalConnectionProfiles.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              ...patch
            }
          : profile
      )
    );
  };

  const addProfile = () => {
    const name = newProfileName.trim();
    const command = newProfileCommand.trim();

    if (!name || !command) {
      return;
    }

    updateProfiles([
      ...props.settings.terminalConnectionProfiles,
      {
        id: createTerminalProfileId(),
        name,
        command,
        description: newProfileDescription.trim() || undefined
      }
    ]);
    setNewProfileName("");
    setNewProfileCommand("");
    setNewProfileDescription("");
  };

  const updateRemoteProfiles = (profiles: RemoteWorkspaceProfile[]) => {
    void props.onUpdateSettings({
      remoteWorkspaceProfiles: profiles
    });
  };

  const updateRemoteProfile = (profileId: string, patch: Partial<RemoteWorkspaceProfile>) => {
    updateRemoteProfiles(
      props.settings.remoteWorkspaceProfiles.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              ...patch
            }
          : profile
      )
    );
  };

  const addRemoteProfile = () => {
    const nextProfile = toRemoteWorkspaceProfile(newRemoteProfile);

    if (!nextProfile) {
      return;
    }

    updateRemoteProfiles([...props.settings.remoteWorkspaceProfiles, nextProfile]);
    setNewRemoteProfile(createEmptyRemoteWorkspaceDraft());
  };

  const saveDiscordBotSettings = async () => {
    setDiscordBotSaving(true);
    setDiscordBotError("");

    try {
      await props.onUpdateSettings({
        discordBot: {
          enabled: discordBotDraft.enabled,
          token: discordBotDraft.token.trim(),
          workspacePath: discordBotDraft.workspacePath.trim(),
          allowedUserIds: toDiscordIdList(discordBotDraft.allowedUserIds),
          allowedChannelIds: toDiscordIdList(discordBotDraft.allowedChannelIds)
        }
      });
    } catch (error) {
      setDiscordBotError(toErrorMessage(error));
    } finally {
      setDiscordBotSaving(false);
    }
  };

  return (
    <div
      className="settings-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
      role="presentation"
    >
      <section
        aria-labelledby="settings-title"
        aria-modal="true"
        className="settings-panel"
        role="dialog"
      >
        <div className="settings-header">
          <div>
            <div className="settings-eyebrow">Preferences</div>
            <h1 id="settings-title">Settings</h1>
          </div>
          <button
            aria-label="Close settings"
            className="settings-close"
            onClick={props.onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-section-head">
            <div className="settings-section-title">Appearance</div>
            <div className="settings-section-copy">
              Keep the app minimal and let the system lead unless you want to pin a mode.
            </div>
          </div>
          <div className="settings-segmented">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={props.settings.themePreference === option.value ? "toolbar-pill active" : "toolbar-pill"}
                onClick={() => props.onSetTheme(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-head">
            <div className="settings-section-title">Prompt Language</div>
            <div className="settings-section-copy">
              Controls the language of Lithium-authored strategist and builder prompts. `Auto`
              follows the latest user direction.
            </div>
          </div>
          <div className="settings-segmented">
            {AUTOPILOT_LANGUAGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={
                  props.settings.autopilotPromptLanguage === option.value
                    ? "toolbar-pill active"
                    : "toolbar-pill"
                }
                onClick={() => {
                  void props.onUpdateSettings({
                    autopilotPromptLanguage: option.value
                  });
                }}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-head">
            <div className="settings-section-title">Setup</div>
            <div className="settings-section-copy">
              Reopen the setup guide or force the next strategist call to restart ChatGPT sign-in.
            </div>
          </div>
          <div className="settings-inline-actions">
            <button className="toolbar-pill" onClick={props.onReopenOnboarding} type="button">
              Show setup guide
            </button>
            <button className="toolbar-pill" onClick={props.onStartStrategistSignIn} type="button">
              {props.settings.strategistSessionReady
                ? "Reset and sign in again"
                : "Sign in to ChatGPT Pro"}
            </button>
          </div>
        </div>

        <SettingsDisclosure
          description="Probe hidden browser reuse only when you need it."
          title="Strategist Tools"
        >
          <div className="settings-section">
            <div className="settings-section-head">
              <div>
                <div className="settings-section-title">Strategist Browser Probe</div>
                <div className="settings-section-copy">
                  Runs a real strategist request through the same main-process path and records
                  whether Oracle Chrome ever became visible, frontmost, or truly headless.
                </div>
              </div>
            </div>
            <div className="settings-section-copy">
              Hidden reuse only matters after the ChatGPT Pro session is verified once. Thinking
              5.4 uses `heavy`; GPT-5.4 Pro uses `extended`.
            </div>
            <div className="settings-inline-actions">
              <button
                className="toolbar-pill"
                disabled={!hiddenProbeReady || props.strategistProbeBusy}
                onClick={() => {
                  props.onRunStrategistProbe({
                    model: "gpt-5.4",
                    reasoningIntensity: "heavy"
                  });
                }}
                type="button"
              >
                Probe Thinking 5.4 heavy
              </button>
              <button
                className="toolbar-pill"
                disabled={!hiddenProbeReady || props.strategistProbeBusy}
                onClick={() => {
                  props.onRunStrategistProbe({
                    model: "gpt-5.4-pro",
                    reasoningIntensity: "extended"
                  });
                }}
                type="button"
              >
                Probe GPT-5.4 Pro
              </button>
            </div>
            {!hiddenProbeReady ? (
              <div className="settings-empty-state">
                Sign in to ChatGPT Pro first, then rerun the probe. Without a verified reusable
                session the first strategist launch is expected to open a visible browser window.
              </div>
            ) : null}
            {props.strategistProbeResult ? (
              <div className="settings-profile-card">
                <div className="settings-status-topline">
                  <span className="settings-status-label">Last probe</span>
                  <span
                    className={props.strategistProbeResult.ok ? "settings-badge ready" : "settings-badge action"}
                  >
                    {props.strategistProbeResult.ok ? "Completed" : "Failed"}
                  </span>
                </div>
                <div className="settings-probe-grid">
                  <div className="settings-probe-stat">
                    <span className="settings-field-label">Model</span>
                    <span>{props.strategistProbeResult.probe.model}</span>
                  </div>
                  <div className="settings-probe-stat">
                    <span className="settings-field-label">Thinking</span>
                    <span>{props.strategistProbeResult.probe.reasoningIntensity}</span>
                  </div>
                  <div className="settings-probe-stat">
                    <span className="settings-field-label">Launch</span>
                    <span>
                      {props.strategistProbeResult.probe.launch.engine === "browser"
                        ? props.strategistProbeResult.probe.launch.browserHeadless
                          ? "browser headless"
                          : props.strategistProbeResult.probe.launch.browserVisible
                          ? "browser visible"
                          : "browser hidden"
                        : "api"}
                    </span>
                  </div>
                  <div className="settings-probe-stat">
                    <span className="settings-field-label">Visible window</span>
                    <span>{props.strategistProbeResult.probe.observedVisibleWindow ? "yes" : "no"}</span>
                  </div>
                  <div className="settings-probe-stat">
                    <span className="settings-field-label">Frontmost</span>
                    <span>{props.strategistProbeResult.probe.observedFrontmostWindow ? "yes" : "no"}</span>
                  </div>
                  <div className="settings-probe-stat">
                    <span className="settings-field-label">Headless</span>
                    <span>{props.strategistProbeResult.probe.observedHeadlessProcess ? "yes" : "no"}</span>
                  </div>
                </div>
                <div className="settings-section-copy">
                  Samples: {props.strategistProbeResult.probe.sampleCount}. Report:
                </div>
                <code className="settings-inline-code">{props.strategistProbeResult.probe.reportPath}</code>
                {props.strategistProbeResult.error ? (
                  <div className="settings-empty-state">{props.strategistProbeResult.error}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsDisclosure>

        <SettingsDisclosure
          description="Keep SSH, containers, and Discord available without crowding the default view."
          title="Remote & Integrations"
        >
          <div className="settings-section">
            {TERMINAL_FEATURE_ENABLED ? (
              <>
                <div className="settings-section-head">
                  <div className="settings-section-title">Remote Terminal Presets</div>
                  <div className="settings-section-copy">
                    Save reusable `ssh`, `docker exec`, or chained attach commands here. These presets
                    reconnect the integrated terminal into a fresh session.
                  </div>
                </div>

                <div className="settings-profile-list">
                  {props.settings.terminalConnectionProfiles.length ? (
                    props.settings.terminalConnectionProfiles.map((profile) => (
                      <article key={profile.id} className="settings-profile-card">
                      <label className="settings-field">
                        <span className="settings-field-label">Name</span>
                        <input
                          className="settings-input"
                          onChange={(event) => {
                            updateProfile(profile.id, { name: event.target.value });
                          }}
                          type="text"
                          value={profile.name}
                        />
                      </label>

                      <label className="settings-field">
                        <span className="settings-field-label">Command</span>
                        <textarea
                          className="settings-textarea settings-command-textarea"
                          onChange={(event) => {
                            updateProfile(profile.id, { command: event.target.value });
                          }}
                          rows={3}
                          value={profile.command}
                        />
                      </label>

                      <label className="settings-field">
                        <span className="settings-field-label">Description</span>
                        <input
                          className="settings-input"
                          onChange={(event) => {
                            updateProfile(profile.id, { description: event.target.value });
                          }}
                          placeholder="Optional note shown in the terminal toolbar"
                          type="text"
                          value={profile.description ?? ""}
                        />
                      </label>

                      <div className="settings-inline-actions">
                        <div className="settings-section-copy">
                          Example: `ssh gpu-box -t 'cd /workspace/project && exec /bin/bash -il'`
                        </div>
                        <button
                          className="toolbar-pill"
                          onClick={() => {
                            updateProfiles(
                              props.settings.terminalConnectionProfiles.filter((entry) => entry.id !== profile.id)
                            );
                          }}
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                      </article>
                    ))
                  ) : (
                    <div className="settings-empty-state">
                      No presets yet. Add one for GPU SSH hosts, remote Docker attach, or any other
                      shell-based entrypoint.
                    </div>
                  )}
                </div>

                <div className="settings-profile-card">
                <label className="settings-field">
                  <span className="settings-field-label">New preset name</span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setNewProfileName(event.target.value);
                    }}
                    placeholder="GPU server"
                    type="text"
                    value={newProfileName}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-field-label">New preset command</span>
                  <textarea
                    className="settings-textarea settings-command-textarea"
                    onChange={(event) => {
                      setNewProfileCommand(event.target.value);
                    }}
                    placeholder="ssh gpu-box -t 'cd /workspace/project && exec /bin/bash -il'"
                    rows={3}
                    value={newProfileCommand}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-field-label">Description</span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setNewProfileDescription(event.target.value);
                    }}
                    placeholder="Optional note shown in the terminal toolbar"
                    type="text"
                    value={newProfileDescription}
                  />
                </label>

                <div className="settings-inline-actions">
                  <div className="settings-section-copy">
                    You can also use `docker exec -it trainer /bin/bash` or an SSH command that jumps
                    straight into a remote container.
                  </div>
                  <button
                    className="toolbar-pill"
                    disabled={!newProfileName.trim() || !newProfileCommand.trim()}
                    onClick={addProfile}
                    type="button"
                  >
                    Add preset
                  </button>
                </div>
              </div>
            </>
            ) : null}
          </div>

        <div className="settings-section">
          <div className="settings-section-head">
            <div>
              <div className="settings-section-title">Remote Workspaces</div>
              <div className="settings-section-copy">
                Mirror a remote repo into a local workspace, then keep saves and paper compile
                routed back over SSH. Container profiles can attach with `docker exec` or
                `devcontainer exec`.
              </div>
            </div>
            <button
              className="toolbar-pill"
              disabled={props.appState.selectedWorkspaceKind === "local" || !props.appState.selectedWorkspacePath}
              onClick={() => {
                void props.onSyncRemoteWorkspace();
              }}
              type="button"
            >
              Sync current remote
            </button>
          </div>

          <div className="settings-profile-list">
            {props.settings.remoteWorkspaceProfiles.length ? (
              props.settings.remoteWorkspaceProfiles.map((profile) => (
                <article key={profile.id} className="settings-profile-card">
                  <label className="settings-field">
                    <span className="settings-field-label">Name</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { name: event.target.value });
                      }}
                      type="text"
                      value={profile.name}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Kind</span>
                    <select
                      className="settings-input"
                      onChange={(event) => {
                        const nextKind = event.target.value === "container" ? "container" : "ssh";
                        updateRemoteProfile(profile.id, {
                          kind: nextKind,
                          containerName: nextKind === "container" ? profile.containerName : undefined,
                          containerWorkspacePath:
                            nextKind === "container" ? profile.containerWorkspacePath : undefined,
                          devcontainerConfigPath:
                            nextKind === "container" ? profile.devcontainerConfigPath : undefined,
                          dockerContext: nextKind === "container" ? profile.dockerContext : undefined
                        });
                      }}
                      value={profile.kind}
                    >
                      <option value="ssh">SSH host</option>
                      <option value="container">Remote container</option>
                    </select>
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Host</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { host: event.target.value });
                      }}
                      placeholder="gpu-box.example.org"
                      type="text"
                      value={profile.host}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Username</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { username: event.target.value });
                      }}
                      placeholder="researcher"
                      type="text"
                      value={profile.username}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Port</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        const raw = event.target.value.trim();
                        updateRemoteProfile(profile.id, {
                          port: raw ? Number(raw) : undefined
                        });
                      }}
                      placeholder="22"
                      type="number"
                      value={profile.port ?? ""}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Remote workspace path</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { remotePath: event.target.value });
                      }}
                      placeholder="/workspace/project"
                      type="text"
                      value={profile.remotePath}
                    />
                  </label>

                  {profile.kind === "container" ? (
                    <>
                      <label className="settings-field">
                        <span className="settings-field-label">Container name</span>
                        <input
                          className="settings-input"
                          onChange={(event) => {
                            updateRemoteProfile(profile.id, { containerName: event.target.value || undefined });
                          }}
                          placeholder="trainer"
                          type="text"
                          value={profile.containerName ?? ""}
                        />
                      </label>

                      <label className="settings-field">
                        <span className="settings-field-label">Container workspace path</span>
                        <input
                          className="settings-input"
                          onChange={(event) => {
                            updateRemoteProfile(profile.id, {
                              containerWorkspacePath: event.target.value || undefined
                            });
                          }}
                          placeholder="/workspace/project"
                          type="text"
                          value={profile.containerWorkspacePath ?? ""}
                        />
                      </label>

                      <label className="settings-field">
                        <span className="settings-field-label">Devcontainer config path</span>
                        <input
                          className="settings-input"
                          onChange={(event) => {
                            updateRemoteProfile(profile.id, {
                              devcontainerConfigPath: event.target.value || undefined
                            });
                          }}
                          placeholder=".devcontainer/devcontainer.json"
                          type="text"
                          value={profile.devcontainerConfigPath ?? ""}
                        />
                      </label>

                      <label className="settings-field">
                        <span className="settings-field-label">Docker context</span>
                        <input
                          className="settings-input"
                          onChange={(event) => {
                            updateRemoteProfile(profile.id, { dockerContext: event.target.value || undefined });
                          }}
                          placeholder="gpu-prod"
                          type="text"
                          value={profile.dockerContext ?? ""}
                        />
                      </label>
                    </>
                  ) : null}

                  <label className="settings-field">
                    <span className="settings-field-label">Private key path</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { privateKeyPath: event.target.value || undefined });
                      }}
                      placeholder="~/.ssh/id_ed25519"
                      type="text"
                      value={profile.privateKeyPath ?? ""}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Host fingerprint</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { hostFingerprint: event.target.value || undefined });
                      }}
                      placeholder="SHA256:..."
                      type="text"
                      value={profile.hostFingerprint ?? ""}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Shell</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { shell: event.target.value || undefined });
                      }}
                      placeholder="/bin/bash -il"
                      type="text"
                      value={profile.shell ?? ""}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Bootstrap command</span>
                    <textarea
                      className="settings-textarea settings-command-textarea"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, {
                          bootstrapCommand: event.target.value || undefined
                        });
                      }}
                      placeholder="source ~/.venv/bin/activate"
                      rows={2}
                      value={profile.bootstrapCommand ?? ""}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Description</span>
                    <input
                      className="settings-input"
                      onChange={(event) => {
                        updateRemoteProfile(profile.id, { description: event.target.value || undefined });
                      }}
                      placeholder="Optional note shown in Settings"
                      type="text"
                      value={profile.description ?? ""}
                    />
                  </label>

                  <div className="settings-inline-actions">
                    <div className="settings-section-copy">
                      {profile.kind === "container"
                        ? "Use `container name` for an existing container, or `devcontainer config path` to auto-run `devcontainer up/exec` on the SSH host."
                        : "Files sync over SFTP and the integrated terminal auto-attaches through SSH."}
                    </div>
                    <div className="settings-inline-actions">
                      <button
                        className="toolbar-pill"
                        onClick={() => {
                          void props.onConnectRemoteWorkspace(profile.id);
                        }}
                        type="button"
                      >
                        Open remote
                      </button>
                      <button
                        className="toolbar-pill"
                        onClick={() => {
                          updateRemoteProfiles(
                            props.settings.remoteWorkspaceProfiles.filter((entry) => entry.id !== profile.id)
                          );
                        }}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <div className="settings-empty-state">
                No remote workspace profiles yet. Add an SSH repo or remote container target,
                then open it from here to work against a mirrored local workspace.
              </div>
            )}
          </div>

          <div className="settings-profile-card">
            <label className="settings-field">
              <span className="settings-field-label">New profile name</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, name: event.target.value }));
                }}
                placeholder="GPU research box"
                type="text"
                value={newRemoteProfile.name}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Kind</span>
              <select
                className="settings-input"
                onChange={(event) => {
                  const nextKind = event.target.value === "container" ? "container" : "ssh";
                  setNewRemoteProfile((current) => ({
                    ...current,
                    kind: nextKind,
                    containerName: nextKind === "container" ? current.containerName : "",
                    containerWorkspacePath: nextKind === "container" ? current.containerWorkspacePath : "",
                    devcontainerConfigPath: nextKind === "container" ? current.devcontainerConfigPath : "",
                    dockerContext: nextKind === "container" ? current.dockerContext : ""
                  }));
                }}
                value={newRemoteProfile.kind}
              >
                <option value="ssh">SSH host</option>
                <option value="container">Remote container</option>
              </select>
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Host</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, host: event.target.value }));
                }}
                placeholder="gpu-box.example.org"
                type="text"
                value={newRemoteProfile.host}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Username</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, username: event.target.value }));
                }}
                placeholder="researcher"
                type="text"
                value={newRemoteProfile.username}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Port</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, port: event.target.value }));
                }}
                placeholder="22"
                type="number"
                value={newRemoteProfile.port}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Remote workspace path</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, remotePath: event.target.value }));
                }}
                placeholder="/workspace/project"
                type="text"
                value={newRemoteProfile.remotePath}
              />
            </label>

            {newRemoteProfile.kind === "container" ? (
              <>
                <label className="settings-field">
                  <span className="settings-field-label">Container name</span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setNewRemoteProfile((current) => ({ ...current, containerName: event.target.value }));
                    }}
                    placeholder="trainer"
                    type="text"
                    value={newRemoteProfile.containerName}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-field-label">Container workspace path</span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setNewRemoteProfile((current) => ({
                        ...current,
                        containerWorkspacePath: event.target.value
                      }));
                    }}
                    placeholder="/workspace/project"
                    type="text"
                    value={newRemoteProfile.containerWorkspacePath}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-field-label">Devcontainer config path</span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setNewRemoteProfile((current) => ({
                        ...current,
                        devcontainerConfigPath: event.target.value
                      }));
                    }}
                    placeholder=".devcontainer/devcontainer.json"
                    type="text"
                    value={newRemoteProfile.devcontainerConfigPath}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-field-label">Docker context</span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setNewRemoteProfile((current) => ({ ...current, dockerContext: event.target.value }));
                    }}
                    placeholder="gpu-prod"
                    type="text"
                    value={newRemoteProfile.dockerContext}
                  />
                </label>
              </>
            ) : null}

            <label className="settings-field">
              <span className="settings-field-label">Private key path</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, privateKeyPath: event.target.value }));
                }}
                placeholder="~/.ssh/id_ed25519"
                type="text"
                value={newRemoteProfile.privateKeyPath}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Host fingerprint</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, hostFingerprint: event.target.value }));
                }}
                placeholder="SHA256:..."
                type="text"
                value={newRemoteProfile.hostFingerprint}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Shell</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, shell: event.target.value }));
                }}
                placeholder="/bin/bash -il"
                type="text"
                value={newRemoteProfile.shell}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Bootstrap command</span>
              <textarea
                className="settings-textarea settings-command-textarea"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, bootstrapCommand: event.target.value }));
                }}
                placeholder="source ~/.venv/bin/activate"
                rows={2}
                value={newRemoteProfile.bootstrapCommand}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Description</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  setNewRemoteProfile((current) => ({ ...current, description: event.target.value }));
                }}
                placeholder="Optional note shown in Settings"
                type="text"
                value={newRemoteProfile.description}
              />
            </label>

            <div className="settings-inline-actions">
              <div className="settings-section-copy">
                Container profiles need either an existing container name or a devcontainer config
                path so Lithium knows how to enter the workspace.
              </div>
              <button className="toolbar-pill" onClick={addRemoteProfile} type="button">
                Add remote workspace
              </button>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-head">
            <div>
              <div className="settings-section-title">Discord Bot</div>
              <div className="settings-section-copy">
                Connect a Discord bot from inside Lithium. DMs work directly; server
                messages only run when the bot is mentioned inside an allowlisted channel.
              </div>
            </div>
            <span className={resolveDiscordBotBadgeClass(discordBotStatus)}>
              {resolveDiscordBotBadgeLabel(discordBotStatus)}
            </span>
          </div>

          <div className="settings-profile-card">
            <div className="settings-inline-actions">
              <div className="settings-section-copy">
                Save once and the main process will connect or reconfigure the bot immediately.
                The token is stored in the app settings file on this machine.
              </div>
              <button
                className={discordBotDraft.enabled ? "toolbar-pill active" : "toolbar-pill"}
                onClick={() => {
                  setDiscordBotDraft((current) => ({
                    ...current,
                    enabled: !current.enabled
                  }));
                }}
                type="button"
              >
                {discordBotDraft.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <label className="settings-field">
              <span className="settings-field-label">Bot token</span>
              <div className="settings-inline-actions">
                <input
                  className="settings-input"
                  onChange={(event) => {
                    const value = event.target.value;
                    setDiscordBotDraft((current) => ({
                      ...current,
                      token: value
                    }));
                  }}
                  placeholder="Paste the Discord bot token"
                  type={discordTokenVisible ? "text" : "password"}
                  value={discordBotDraft.token}
                />
                <button
                  className="toolbar-pill"
                  onClick={() => setDiscordTokenVisible((current) => !current)}
                  type="button"
                >
                  {discordTokenVisible ? "Hide" : "Show"}
                </button>
              </div>
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Workspace path</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  const value = event.target.value;
                  setDiscordBotDraft((current) => ({
                    ...current,
                    workspacePath: value
                  }));
                }}
                placeholder="Leave blank to use the currently selected workspace"
                type="text"
                value={discordBotDraft.workspacePath}
              />
            </label>

            <div className="settings-inline-actions">
              <div className="settings-section-copy">
                If this stays blank, the bot falls back to the current workspace selected in the
                desktop app.
              </div>
              <button
                className="toolbar-pill"
                disabled={!props.appState.selectedWorkspacePath}
                onClick={() => {
                  setDiscordBotDraft((current) => ({
                    ...current,
                    workspacePath: props.appState.selectedWorkspacePath
                  }));
                }}
                type="button"
              >
                Use current workspace
              </button>
            </div>

            <label className="settings-field">
              <span className="settings-field-label">Allowed user ids</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  const value = event.target.value;
                  setDiscordBotDraft((current) => ({
                    ...current,
                    allowedUserIds: value
                  }));
                }}
                placeholder="Comma-separated user ids; blank means any user"
                type="text"
                value={discordBotDraft.allowedUserIds}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Allowed channel ids</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  const value = event.target.value;
                  setDiscordBotDraft((current) => ({
                    ...current,
                    allowedChannelIds: value
                  }));
                }}
                placeholder="Comma-separated channel ids for server mentions"
                type="text"
                value={discordBotDraft.allowedChannelIds}
              />
            </label>

            <div className="settings-status-grid">
              <article className="settings-status-card">
                <div className="settings-status-topline">
                  <span className="settings-status-label">Connection</span>
                  <span className={resolveDiscordBotBadgeClass(discordBotStatus)}>
                    {resolveDiscordBotBadgeLabel(discordBotStatus)}
                  </span>
                </div>
                <div className="settings-status-body">
                  {discordBotStatus.botTag
                    ? `${discordBotStatus.botTag} (${discordBotStatus.botUserId})`
                    : "No Discord bot session is active yet."}
                </div>
              </article>

              <article className="settings-status-card">
                <div className="settings-status-topline">
                  <span className="settings-status-label">Workspace</span>
                  <span className="settings-badge ready">
                    {discordBotStatus.workspacePath ? "Pinned" : "Follow app"}
                  </span>
                </div>
                <div className="settings-status-body">
                  {discordBotStatus.workspacePath ||
                    props.appState.selectedWorkspacePath ||
                    "No workspace is selected yet."}
                </div>
              </article>

              <article className="settings-status-card">
                <div className="settings-status-topline">
                  <span className="settings-status-label">Server mode</span>
                  <span className={props.settings.discordBot.allowedChannelIds.length ? "settings-badge ready" : "settings-badge action"}>
                    {props.settings.discordBot.allowedChannelIds.length ? "Allowlisted" : "DM only"}
                  </span>
                </div>
                <div className="settings-status-body">
                  {props.settings.discordBot.allowedChannelIds.length
                    ? "Guild messages run only when the bot is mentioned in one of the saved channel ids."
                    : "Without saved channel ids the bot only answers DMs."}
                </div>
              </article>
            </div>

            {discordBotStatus.lastError ? (
              <div className="settings-empty-state">{discordBotStatus.lastError}</div>
            ) : null}
            {discordBotError ? <div className="settings-empty-state">{discordBotError}</div> : null}

            <div className="settings-inline-actions">
              <div className="settings-section-copy">
                This bridge currently supports text prompts. Discord attachments are not imported
                into the active thread yet.
              </div>
              <button
                className="toolbar-pill"
                disabled={discordBotSaving || (discordBotDraft.enabled && !discordBotDraft.token.trim())}
                onClick={() => {
                  void saveDiscordBotSettings();
                }}
                type="button"
              >
                {discordBotSaving ? "Saving..." : discordBotDraft.enabled ? "Save and connect" : "Save"}
              </button>
            </div>
            </div>
          </div>
        </SettingsDisclosure>

        <SettingsDisclosure
          description="Read-only lane health when you need to inspect the app environment."
          title="Runtime Status"
        >
          <div className="settings-section">
            <div className="settings-section-head">
              <div className="settings-section-title">Environment</div>
              <div className="settings-section-copy">
                Read-only runtime status for the lanes this app depends on.
              </div>
            </div>
            <div className="settings-status-grid">
            <article className="settings-status-card">
              <div className="settings-status-topline">
                <span className="settings-status-label">Strategist browser</span>
                <span className={props.appState.oracleChromePath ? "settings-badge ready" : "settings-badge action"}>
                  {props.appState.oracleChromePath ? "Ready" : "Missing"}
                </span>
              </div>
              <div className="settings-status-body">
                {props.appState.oracleChromePath
                  ? "Chrome or Chromium is available for the ChatGPT Pro login flow."
                  : "Install Chrome or Chromium so the strategist lane can reuse a real ChatGPT session."}
              </div>
            </article>

            <article className="settings-status-card">
              <div className="settings-status-topline">
                <span className="settings-status-label">ChatGPT Pro session</span>
                <span
                  className={
                    props.settings.strategistSessionReady ? "settings-badge ready" : "settings-badge action"
                  }
                >
                  {props.settings.strategistSessionReady ? "Verified" : "Needs sign-in"}
                </span>
              </div>
              <div className="settings-status-body">
                {props.settings.strategistSessionReady
                  ? "This clears the saved Lithium browser profile, opens a fresh ChatGPT login window, and closes it automatically once sign-in is complete."
                  : "Open a one-time ChatGPT Pro login window here, then later strategist runs can reuse that session quietly in the background."}
              </div>
            </article>

            <article className="settings-status-card">
              <div className="settings-status-topline">
                <span className="settings-status-label">Builder CLI</span>
                <span className={props.appState.codexReady ? "settings-badge ready" : "settings-badge action"}>
                  {props.appState.codexReady ? "Ready" : "Missing"}
                </span>
              </div>
              <div className="settings-status-body">
                {props.appState.codexReady
                  ? "Codex CLI is available in PATH."
                  : "Install Codex CLI and expose the `codex` command in PATH to enable builder runs."}
              </div>
            </article>

            <article className="settings-status-card">
              <div className="settings-status-topline">
                <span className="settings-status-label">Workspace</span>
                <span
                  className={
                    props.appState.selectedWorkspacePath ? "settings-badge ready" : "settings-badge action"
                  }
                >
                  {props.appState.selectedWorkspacePath
                    ? props.appState.selectedWorkspaceKind === "local"
                      ? "Local"
                      : "Remote"
                    : "Not set"}
                </span>
              </div>
              <div className="settings-status-body">
                {props.appState.selectedWorkspaceLabel ||
                  "Open a local folder with Cmd+O, or just start chatting and let Lithium create an untitled workspace."}
              </div>
            </article>
            </div>
          </div>
        </SettingsDisclosure>
      </section>
    </div>
  );
}

type SettingsDisclosureProps = {
  children: ReactNode;
  description: string;
  title: string;
};

function SettingsDisclosure(props: SettingsDisclosureProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className={open ? "settings-disclosure open" : "settings-disclosure"}>
      <button
        aria-expanded={open}
        className="settings-disclosure-toggle"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="settings-disclosure-copy">
          <span className="settings-disclosure-title">{props.title}</span>
          <span className="settings-disclosure-description">{props.description}</span>
        </span>
        <span className="settings-disclosure-icon" aria-hidden="true">
          <svg fill="none" viewBox="0 0 20 20">
            <path
              d="m6 8 4 4 4-4"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
        </span>
      </button>
      {open ? <div className="settings-disclosure-body">{props.children}</div> : null}
    </section>
  );
}

function createTerminalProfileId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `terminal-profile-${Date.now()}`;
}

type DiscordBotDraft = {
  enabled: boolean;
  token: string;
  workspacePath: string;
  allowedUserIds: string;
  allowedChannelIds: string;
};

type RemoteWorkspaceDraft = {
  name: string;
  kind: "ssh" | "container";
  host: string;
  username: string;
  remotePath: string;
  description: string;
  port: string;
  privateKeyPath: string;
  hostFingerprint: string;
  shell: string;
  bootstrapCommand: string;
  containerName: string;
  containerWorkspacePath: string;
  devcontainerConfigPath: string;
  dockerContext: string;
};

function createDiscordBotDraft(settings: DiscordBotSettings): DiscordBotDraft {
  return {
    enabled: settings.enabled,
    token: settings.token,
    workspacePath: settings.workspacePath,
    allowedUserIds: settings.allowedUserIds.join(", "),
    allowedChannelIds: settings.allowedChannelIds.join(", ")
  };
}

function toDiscordIdList(value: string) {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function resolveDiscordBotBadgeClass(status: DiscordBotRuntimeStatus) {
  return status.state === "connected" ? "settings-badge ready" : "settings-badge action";
}

function resolveDiscordBotBadgeLabel(status: DiscordBotRuntimeStatus) {
  switch (status.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    default:
      return "Disabled";
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createEmptyRemoteWorkspaceDraft(): RemoteWorkspaceDraft {
  return {
    name: "",
    kind: "ssh",
    host: "",
    username: "",
    remotePath: "",
    description: "",
    port: "",
    privateKeyPath: "",
    hostFingerprint: "",
    shell: "",
    bootstrapCommand: "",
    containerName: "",
    containerWorkspacePath: "",
    devcontainerConfigPath: "",
    dockerContext: ""
  };
}

function toRemoteWorkspaceProfile(draft: RemoteWorkspaceDraft): RemoteWorkspaceProfile | null {
  const name = draft.name.trim();
  const host = draft.host.trim();
  const username = draft.username.trim();
  const remotePath = draft.remotePath.trim();
  const port = draft.port.trim();

  if (!name || !host || !username || !remotePath) {
    return null;
  }

  if (draft.kind === "container" && !draft.containerName.trim() && !draft.devcontainerConfigPath.trim()) {
    return null;
  }

  return {
    id: createRemoteWorkspaceProfileId(),
    name,
    kind: draft.kind,
    host,
    username,
    remotePath,
    description: draft.description.trim() || undefined,
    port: port ? Number(port) : undefined,
    privateKeyPath: draft.privateKeyPath.trim() || undefined,
    hostFingerprint: draft.hostFingerprint.trim() || undefined,
    shell: draft.shell.trim() || undefined,
    bootstrapCommand: draft.bootstrapCommand.trim() || undefined,
    containerName: draft.containerName.trim() || undefined,
    containerWorkspacePath: draft.containerWorkspacePath.trim() || undefined,
    devcontainerConfigPath: draft.devcontainerConfigPath.trim() || undefined,
    dockerContext: draft.dockerContext.trim() || undefined
  };
}

function createRemoteWorkspaceProfileId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `remote-workspace-${Date.now()}`;
}
