import type { VoiceEvent } from "./types";

type Pending = {
  result: (data: unknown) => void;
  fail: (error: Error) => void;
  audio?: ReadableStreamDefaultController<Uint8Array>;
  cleanup: () => void;
  event?: (event: VoiceEvent) => void;
};

/** One connection per browser tab; request ids make cancellation and streamed audio independent. */
class VoiceSocket {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  private async open() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    const base = process.env.NEXT_PUBLIC_BACKEND_URL || `${location.protocol}//${location.hostname}:8000`;
    const url = new URL("/ws/voice", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.opening = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => socket.close(), 10_000);
      socket.onopen = () => { clearTimeout(timeout); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error("Voice backend unavailable. Start it with npm run dev.")); };
      socket.onclose = () => {
        clearTimeout(timeout);
        const error = new Error("Voice connection closed. Enable the microphone to reconnect.");
        reject(error);
        for (const id of this.pending.keys()) this.finish(id, error);
        if (this.socket === socket) { this.socket = null; this.opening = null; }
      };
      socket.onmessage = ({ data }) => {
        if (data instanceof ArrayBuffer) {
          if (data.byteLength < 4) return;
          const id = new DataView(data).getUint32(0, true);
          this.pending.get(id)?.audio?.enqueue(new Uint8Array(data, 4));
          return;
        }
        const message = JSON.parse(data) as { id: number; type: string; data?: unknown; error?: string };
        const request = this.pending.get(message.id);
        if (!request) return;
        if (message.type === "progress" || message.type === "route" || message.type === "action") { request.event?.(message as unknown as VoiceEvent); return; }
        if (message.type === "error") this.finish(message.id, new Error(message.error || "Voice request failed."));
        else {
          if (message.type === "done") request.audio?.close();
          request.result(message.data);
          this.finish(message.id);
        }
      };
    });
    return this.opening;
  }

  /** Pose updates share the live socket; they don't create requests or invoke the model. */
  updateState(payload: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 64_000) {
      this.socket.send(JSON.stringify({ id: 1, type: "state", payload }));
    }
  }

  private finish(id: number, error?: Error) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.cleanup();
    if (error) { request.audio?.error(error); request.fail(error); }
  }

  private register(id: number, signal: AbortSignal, request: Omit<Pending, "cleanup">) {
    const cancel = () => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id, type: "cancel" }));
      this.finish(id, new DOMException("Interrupted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cancel();
    }, 120_000);
    this.pending.set(id, { ...request, cleanup: () => { clearTimeout(timeout); signal.removeEventListener("abort", cancel); } });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  }

  async request<T>(type: "token" | "voices" | "turn", payload: unknown, signal: AbortSignal, event?: (event: VoiceEvent) => void): Promise<T> {
    await this.open();
    signal.throwIfAborted();
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.register(id, signal, { result: (data) => resolve(data as T), fail: reject, event });
      this.socket!.send(JSON.stringify({ id, type, payload }));
    });
  }

  async speech(payload: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    await this.open();
    signal.throwIfAborted();
    const id = ++this.nextId;
    return new ReadableStream<Uint8Array>({
      start: (audio) => {
        this.register(id, signal, { result: () => {}, fail: () => {}, audio });
        this.socket!.send(JSON.stringify({ id, type: "speak", payload }));
      },
      cancel: () => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id, type: "cancel" }));
        this.finish(id);
      },
    });
  }
}

export const voiceSocket = new VoiceSocket();
