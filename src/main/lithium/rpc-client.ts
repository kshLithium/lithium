import { readFile } from "node:fs/promises";
import net from "node:net";
import type { RpcRequest, RpcResponse } from "../../shared/types";
import { buildProjectPaths } from "../services/workspace-layout";
import { coerceErrorMessage, createId } from "./utils";

export async function sendRpc<T = unknown>(workspacePath: string, method: RpcRequest["method"], params?: Record<string, unknown>) {
  const paths = buildProjectPaths(workspacePath);
  const request: RpcRequest = {
    id: createId("rpc"),
    method,
    params
  };
  const response = await new Promise<RpcResponse>((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath);
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) {
        return;
      }
      const line = buffer.slice(0, buffer.indexOf("\n"));
      socket.end();
      try {
        resolve(JSON.parse(line) as RpcResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });

  if (!response.ok) {
    throw new Error(response.error ?? `RPC ${method} failed.`);
  }
  return response.result as T;
}

export async function waitForDaemonSocket(workspacePath: string, timeoutMs = 10_000) {
  const started = Date.now();
  let lastError = "Daemon socket did not appear.";
  while (Date.now() - started < timeoutMs) {
    try {
      await sendRpc(workspacePath, "daemon.status");
      return;
    } catch (error) {
      lastError = coerceErrorMessage(error);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(lastError);
}

export async function readDaemonPid(workspacePath: string) {
  const paths = buildProjectPaths(workspacePath);
  const raw = await readFile(paths.pidFile, "utf8").catch(() => "");
  const pid = Number(raw.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}
