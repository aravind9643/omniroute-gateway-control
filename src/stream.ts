// OpenAI chat-completions SSE parsing plus OmniRoute's per-request routing headers.
// No vscode import: unit-tested directly from out/stream.js.

export interface StreamSink {
  text(chunk: string): void;
  reasoning(chunk: string): void;
  toolCall(id: string, name: string, input: object): void;
}

export interface StreamUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** Model id the upstream reported in the stream (may differ from the requested alias/combo). */
  servedModel?: string;
}

/** What OmniRoute tells us about how a request was routed (X-OmniRoute-* response headers). */
export interface RoutingInfo {
  requestId?: string;
  model?: string;
  provider?: string;
  /** e.g. "combo:coding strategy=priority provider=anthropic latency=812ms" — free-form, shown verbatim. */
  decision?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  fallbackAttempts?: number;
  cache?: "HIT" | "MISS" | string;
  cacheSavedUsd?: number;
  compression?: string;
  version?: string;
}

const num = (v: string | null | undefined) => {
  if (v == null || v === "") return undefined;
  const n = Number(String(v).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

/** Reads OmniRoute's response headers; works with fetch Headers or a plain lowercase map. */
export function parseRoutingHeaders(h: { get(name: string): string | null } | Record<string, string>): RoutingInfo {
  const get = (name: string): string | undefined => {
    if (typeof (h as any).get === "function") return (h as any).get(name) ?? undefined;
    const rec = h as Record<string, string>;
    return rec[name] ?? rec[name.toLowerCase()] ?? undefined;
  };
  const info: RoutingInfo = {
    requestId: get("x-omniroute-request-id") || get("x-request-id"),
    model: get("x-omniroute-model"),
    provider: get("x-omniroute-provider"),
    decision: get("x-omniroute-decision"),
    costUsd: num(get("x-omniroute-response-cost")),
    tokensIn: num(get("x-omniroute-tokens-in")),
    tokensOut: num(get("x-omniroute-tokens-out")),
    latencyMs: num(get("x-omniroute-latency-ms")),
    fallbackAttempts: num(get("x-omniroute-fallback-attempts")),
    cache: get("x-omniroute-cache") || (get("x-omniroute-cache-hit") === "true" ? "HIT" : undefined),
    cacheSavedUsd: num(get("x-omniroute-cache-saved") ?? get("x-omniroute-cost-saved")),
    compression: get("x-omniroute-compression"),
    version: get("x-omniroute-version"),
  };
  for (const k of Object.keys(info) as (keyof RoutingInfo)[]) if (info[k] === undefined) delete info[k];
  return info;
}

/** One-line human summary of a routed request, e.g. "anthropic · claude-sonnet-5-5 · 812ms · $0.0031 · cache HIT". */
export function describeRouting(r: RoutingInfo): string {
  const parts: string[] = [];
  if (r.provider) parts.push(r.provider);
  if (r.model) parts.push(r.model);
  if (r.latencyMs !== undefined) parts.push(`${Math.round(r.latencyMs)}ms`);
  if (r.costUsd !== undefined) parts.push(formatUsd(r.costUsd));
  if (r.fallbackAttempts) parts.push(`${r.fallbackAttempts} fallback${r.fallbackAttempts === 1 ? "" : "s"}`);
  if (r.cache === "HIT") parts.push("cache hit");
  return parts.join(" · ");
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  return `$${usd < 0.01 ? usd.toFixed(4) : usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** Parses an OpenAI chat-completions SSE stream into sink calls. Tool calls are emitted after the stream ends. */
export async function readChatStream(stream: ReadableStream<Uint8Array>, sink: StreamSink, signal?: AbortSignal): Promise<StreamUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  const usage: StreamUsage = {};
  let buffer = "";
  let finished = false;
  try {
    while (!finished && !signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finished = true;
          break;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk?.error) throw new StreamError(chunk.error.message || JSON.stringify(chunk.error));
        if (typeof chunk?.model === "string" && !usage.servedModel) usage.servedModel = chunk.model;
        if (chunk?.usage) {
          if (typeof chunk.usage.prompt_tokens === "number") usage.promptTokens = chunk.usage.prompt_tokens;
          if (typeof chunk.usage.completion_tokens === "number") usage.completionTokens = chunk.usage.completion_tokens;
        }
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) sink.reasoning(reasoning);
        if (typeof delta.content === "string" && delta.content) sink.text(delta.content);
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const idx = typeof tc.index === "number" ? tc.index : toolCalls.size;
          let call = toolCalls.get(idx);
          if (!call) toolCalls.set(idx, (call = { id: "", name: "", args: "" }));
          if (tc.id) call.id = tc.id;
          if (tc.function?.name && !call.name) call.name = tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
        }
      }
    }
  } finally {
    // Release the connection: servers may keep the stream open after [DONE].
    void reader.cancel().catch(() => undefined);
  }
  for (const [idx, call] of toolCalls) {
    if (!call.name) continue;
    let input: object = {};
    try {
      const parsed = call.args.trim() ? JSON.parse(call.args) : {};
      if (parsed && typeof parsed === "object") input = parsed;
    } catch {
      // malformed arguments — pass an empty object rather than failing the turn
    }
    sink.toolCall(call.id || `call_${Date.now()}_${idx}`, call.name, input);
  }
  return usage;
}

/** An error event inside the stream (after headers were sent). */
export class StreamError extends Error {}

/** Splits `<think>…</think>` content out of a text stream, even when a tag straddles two chunks. */
export class ThinkTagSplitter {
  private _inThink = false;
  private _pending = "";

  push(chunk: string): { think: boolean; text: string }[] {
    const segs: { think: boolean; text: string }[] = [];
    let buf = this._pending + chunk;
    this._pending = "";
    while (buf) {
      const tag = this._inThink ? "</think>" : "<think>";
      const at = buf.indexOf(tag);
      if (at >= 0) {
        if (at > 0) segs.push({ think: this._inThink, text: buf.slice(0, at) });
        this._inThink = !this._inThink;
        buf = buf.slice(at + tag.length);
        continue;
      }
      let keep = 0;
      for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
        if (tag.startsWith(buf.slice(-n))) {
          keep = n;
          break;
        }
      }
      const emit = buf.slice(0, buf.length - keep);
      if (emit) segs.push({ think: this._inThink, text: emit });
      this._pending = buf.slice(buf.length - keep);
      break;
    }
    return segs;
  }

  flush(): { think: boolean; text: string }[] {
    const rest = this._pending;
    this._pending = "";
    return rest ? [{ think: this._inThink, text: rest }] : [];
  }
}

/** OmniRoute request headers for Copilot traffic. */
export function requestHeaders(cfg: { get<T>(k: string, d: T): T }, sessionId: string, correlationId: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "text/event-stream",
    "X-OmniRoute-Session-Id": sessionId,
    "X-Session-Id": sessionId,
    "X-Correlation-Id": correlationId,
  };
  const compression = cfg.get<string>("compression", "server");
  if (compression && compression !== "server") h["X-OmniRoute-Compression"] = compression;
  if (cfg.get<boolean>("bypassCache", false)) h["X-OmniRoute-No-Cache"] = "true";
  if (cfg.get<boolean>("disableMemory", false)) h["x-omniroute-no-memory"] = "true";
  return h;
}
