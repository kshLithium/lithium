import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { ResolvedTheme } from "../../shared/types";
import { getTerminalBridge, normalizeTerminalEvent, type TerminalSessionSnapshot } from "./terminal-runtime";

type UseTerminalWindowArgs = {
  projectReady: boolean;
  themeMode: ResolvedTheme;
  threadId?: string;
  workspacePath: string;
};

type TerminalSessionLaunchOptions = {
  bootstrapCommand?: string;
  forceNew?: boolean;
};

export function useTerminalWindow(args: UseTerminalWindowArgs) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSessionSnapshot | null>(null);
  const renderedOutputRef = useRef("");
  const launchSessionRef = useRef<(options?: TerminalSessionLaunchOptions) => Promise<void>>(async () => undefined);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [statusLabel, setStatusLabel] = useState<string>("");

  useEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        '"SFMono-Regular", "SF Mono", "Menlo", "Consolas", "Liberation Mono", "monospace"',
      fontSize: 14,
      lineHeight: 1.35,
      scrollback: 2000,
      theme: resolveTerminalTheme(args.themeMode)
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    fitAddonRef.current = fitAddon;
    terminalRef.current = terminal;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);
    terminal.focus();

    let cancelled = false;

    const applyLayout = () => {
      if (!terminalRef.current || !fitAddonRef.current) {
        return;
      }

      fitAddonRef.current.fit();

      const activeSession = sessionRef.current;
      if (activeSession) {
        void getTerminalBridge()
          .resizeTerminalSession({
            workspacePath: args.workspacePath,
            sessionId: activeSession.id,
            cols: terminalRef.current.cols,
            rows: terminalRef.current.rows
          })
          .catch(() => undefined);
      }
    };

    const observer = new ResizeObserver(() => {
      applyLayout();
    });
    observer.observe(host);

    const resizeFrame = window.requestAnimationFrame(() => {
      applyLayout();
    });

    const unsubscribe = getTerminalBridge().onTerminalEvent((event) => {
      const normalized = normalizeTerminalEvent(event);
      const activeSession = sessionRef.current;

      if (
        !normalized ||
        !activeSession ||
        normalized.workspacePath !== args.workspacePath ||
        normalized.sessionId !== activeSession.id
      ) {
        return;
      }

      if (normalized.type === "data") {
        terminal.write(normalized.data);
        renderedOutputRef.current = `${renderedOutputRef.current}${normalized.data}`.slice(-24 * 1024);
        return;
      }

      if (normalized.type === "cwd") {
        const nextSession: TerminalSessionSnapshot = {
          ...activeSession,
          cwd: normalized.cwd
        };
        sessionRef.current = nextSession;
        setSession(nextSession);
        return;
      }

      const nextSession: TerminalSessionSnapshot = {
        ...activeSession,
        active: false
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      setStatusLabel(normalized.exitCode == null ? "closed" : `exit ${normalized.exitCode}`);
      terminal.write("\r\n");
    });

    terminal.onData((data) => {
      const activeSession = sessionRef.current;

      if (!activeSession || !data) {
        return;
      }

      void getTerminalBridge()
        .writeTerminalInput({
          workspacePath: args.workspacePath,
          sessionId: activeSession.id,
          data
        })
        .catch(() => undefined);
    });

    const launchSession = async (options: TerminalSessionLaunchOptions = {}) => {
      if (!args.projectReady || !args.workspacePath) {
        setStatusLabel("open a workspace");
        return;
      }

      setStatusLabel("starting");

      try {
        const created = await getTerminalBridge().createTerminalSession({
          workspacePath: args.workspacePath,
          threadId: args.threadId,
          cwd: args.workspacePath,
          cols: terminal.cols || 80,
          rows: terminal.rows || 24,
          forceNew: options.forceNew,
          bootstrapCommand: options.bootstrapCommand
        });

        if (cancelled) {
          void getTerminalBridge()
            .closeTerminalSession({
              workspacePath: args.workspacePath,
              sessionId: created.id
            })
            .catch(() => undefined);
          return;
        }

        sessionRef.current = created;
        setSession(created);
        setStatusLabel(created.active ? "" : "closed");
        renderedOutputRef.current = created.output ?? "";

        if (created.output) {
          terminal.write(created.output);
        }

        applyLayout();

        const fresh = await getTerminalBridge().getTerminalSession({
          workspacePath: args.workspacePath,
          sessionId: created.id
        });

        if (fresh && !cancelled) {
          sessionRef.current = fresh;
          setSession(fresh);
          setStatusLabel(fresh.active ? "" : "closed");

          if (!renderedOutputRef.current && fresh.output) {
            renderedOutputRef.current = fresh.output;
            terminal.write(fresh.output);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setStatusLabel(error instanceof Error ? "terminal unavailable" : "terminal unavailable");
        }
      }
    };

    launchSessionRef.current = launchSession;
    void launchSession();

    return () => {
      const activeSession = sessionRef.current;

      cancelled = true;
      launchSessionRef.current = async () => undefined;
      window.cancelAnimationFrame(resizeFrame);
      unsubscribe();
      observer.disconnect();
      if (activeSession) {
        void getTerminalBridge()
          .closeTerminalSession({
            workspacePath: args.workspacePath,
            sessionId: activeSession.id
          })
          .catch(() => undefined);
      }
      terminal.dispose();
      renderedOutputRef.current = "";
      sessionRef.current = null;
    };
  }, [args.projectReady, args.threadId, args.workspacePath]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.options.theme = resolveTerminalTheme(args.themeMode);
  }, [args.themeMode]);

  return {
    hostRef,
    restartSession: async (options: TerminalSessionLaunchOptions = {}) => {
      const terminal = terminalRef.current;

      if (terminal) {
        terminal.clear();
        terminal.reset();
      }

      renderedOutputRef.current = "";
      sessionRef.current = null;
      setSession(null);
      await launchSessionRef.current({
        ...options,
        forceNew: true
      });
    },
    statusLabel,
    session
  };
}

function resolveTerminalTheme(themeMode: ResolvedTheme) {
  if (themeMode === "dark") {
    return {
      background: "#11161c",
      foreground: "#e5edf6",
      cursor: "#f8fafc",
      cursorAccent: "#11161c",
      selectionBackground: "rgba(96, 165, 250, 0.22)",
      black: "#111827",
      red: "#f97316",
      green: "#22c55e",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#f8fafc",
      brightBlack: "#64748b",
      brightRed: "#fb923c",
      brightGreen: "#4ade80",
      brightYellow: "#fcd34d",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#5eead4",
      brightWhite: "#ffffff"
    };
  }

  return {
    background: "#ffffff",
    foreground: "#111827",
    cursor: "#111827",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(37, 99, 235, 0.18)",
    black: "#111827",
    red: "#c2410c",
    green: "#15803d",
    yellow: "#a16207",
    blue: "#1d4ed8",
    magenta: "#7c3aed",
    cyan: "#0f766e",
    white: "#f8fafc",
    brightBlack: "#475569",
    brightRed: "#ea580c",
    brightGreen: "#16a34a",
    brightYellow: "#ca8a04",
    brightBlue: "#2563eb",
    brightMagenta: "#8b5cf6",
    brightCyan: "#14b8a6",
    brightWhite: "#0f172a"
  };
}
