import type {
  MobileApiError,
  MobileAutoresearchControlRequest,
  MobileAutoresearchSession,
  MobileAutoresearchStartRequest,
  MobileBootstrap,
  MobileChatRequest,
  MobileMessage,
  MobileThread,
  MobileThreadCreateRequest,
  MobileThreadSelectRequest
} from "./types";

type JsonValue = Record<string, unknown>;

export class MobileApiClient {
  constructor(private readonly baseUrl = "/api/mobile") {}

  async bootstrap(signal?: AbortSignal) {
    return await this.request<MobileBootstrap>("GET", "/bootstrap", undefined, signal);
  }

  async listThreads(signal?: AbortSignal) {
    return await this.request<MobileThread[]>("GET", "/threads", undefined, signal);
  }

  async createThread(body: MobileThreadCreateRequest) {
    return await this.request<MobileBootstrap>("POST", "/threads", body);
  }

  async selectThread(body: MobileThreadSelectRequest) {
    return await this.request<MobileBootstrap>("POST", "/threads/select", body);
  }

  async sendChat(body: MobileChatRequest) {
    return await this.request<MobileMessage[]>("POST", "/chat", body);
  }

  async getMessages(threadId: string, signal?: AbortSignal) {
    return await this.request<MobileMessage[]>("GET", `/threads/${encodeURIComponent(threadId)}/messages`, undefined, signal);
  }

  async getAutoresearch(signal?: AbortSignal) {
    return await this.request<MobileAutoresearchSession | null>("GET", "/autoresearch", undefined, signal);
  }

  async startAutoresearch(body: MobileAutoresearchStartRequest) {
    return await this.request<MobileBootstrap>("POST", "/autoresearch/start", body);
  }

  async pauseAutoresearch(body: MobileAutoresearchControlRequest) {
    return await this.request<MobileBootstrap>("POST", "/autoresearch/pause", body);
  }

  async resumeAutoresearch(body: MobileAutoresearchControlRequest) {
    return await this.request<MobileBootstrap>("POST", "/autoresearch/resume", body);
  }

  async interruptAutoresearch(body: MobileAutoresearchControlRequest) {
    return await this.request<MobileBootstrap>("POST", "/autoresearch/interrupt", body);
  }

  async refreshAutoresearch(body: MobileAutoresearchControlRequest) {
    return await this.request<MobileBootstrap>("POST", "/autoresearch/refresh", body);
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async toError(response: Response): Promise<MobileApiError> {
    let message = `${response.status} ${response.statusText}`;
    const copy = response.clone();

    try {
      const payload = (await copy.json()) as JsonValue;
      const candidate = payload.message || payload.error || payload.detail;

      if (typeof candidate === "string" && candidate.trim()) {
        message = candidate.trim();
      }
    } catch {
      const text = await copy.text().catch(() => "");
      if (text.trim()) {
        message = text.trim();
      }
    }

    return {
      message,
      status: response.status
    };
  }
}
