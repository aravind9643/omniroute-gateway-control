// Typed HTTP client for OmniRoute. No vscode import, so it is unit-tested against test/mockServer.js.
// OmniRoute's envelopes vary by route (bare objects, bare arrays, {combos,total}, {error:string} or
// {error:{message}}); every reader below tolerates the documented variants.
import {
  QUOTA_CUTOFF_DEFAULT, QUOTA_WARN_DEFAULT,
  type ApiKeyInfo, type AutoRoutingStats, type CallLog, type Combo, type ComboStep, type CompressionConfig, type Connection,
  type Cooldown, type HealthInfo, type McpStatus, type OmniModel, type ProviderLimits, type QuotaSnapshot, type QuotaWindow,
  type UsageRow, type UsageSummary,
} from "./types";

export interface Credentials {
  apiKey(): Promise<string | undefined>;
  /** Cookie and/or Bearer headers accepted by OmniRoute's management routes. */
  managementHeaders(): Promise<Record<string, string>>;
}

export interface ClientOptions {
  baseUrl: () => string;
  timeoutMs: () => number;
  credentials: Credentials;
  userAgent?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly path: string) {
    super(message);
  }
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
}

/** Extracts a readable message from any of OmniRoute's error envelopes. */
export function errorMessage(status: number, text: string): string {
  let msg = "";
  try {
    const j = JSON.parse(text);
    const e = j?.error ?? j;
    if (typeof e === "string") msg = e;
    else if (e && typeof e === "object") {
      msg = e.message || e.error || "";
      if (Array.isArray(e.details) && e.details.length) msg += `: ${e.details.map((d: any) => `${d.field ? d.field + " " : ""}${d.message}`).join("; ")}`;
    }
    if (!msg && typeof j?.message === "string") msg = j.message;
  } catch {
    msg = text.trim().slice(0, 200);
  }
  return `HTTP ${status}${msg ? `: ${msg}` : ""}`;
}

/** Trims slashes and a trailing /v1 or /api so users can paste any OmniRoute URL. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/(v1|api)$/i, "");
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(+v) ? +v : undefined);
const list = (j: any, ...keys: string[]): any[] => {
  if (Array.isArray(j)) return j;
  for (const k of keys) if (Array.isArray(j?.[k])) return j[k];
  return [];
};

const NON_CHAT_TYPES = new Set(["embedding", "image", "rerank", "audio", "moderation", "video", "music", "tts", "stt", "ocr"]);

export function toModel(r: any): OmniModel | undefined {
  const id = str(r?.id);
  if (!id) return undefined;
  const caps = r.capabilities || {};
  const ownedBy = str(r.owned_by) || "unknown";
  const kind = /^auto(\/|$)/.test(id) ? "auto" : ownedBy === "combo" ? "combo" : "model";
  const modalities: string[] = Array.isArray(r.input_modalities) ? r.input_modalities : [];
  return {
    id,
    kind,
    ownedBy,
    name: str(r.display_name) || str(r.name) || id,
    description: str(r.description),
    type: str(r.type),
    contextLength: numOr(r.context_length ?? r.max_context_length),
    maxInputTokens: numOr(r.max_input_tokens),
    maxOutputTokens: numOr(r.max_output_tokens),
    toolCalling: typeof caps.tool_calling === "boolean" ? caps.tool_calling : typeof r.toolCalling === "boolean" ? r.toolCalling : undefined,
    vision: typeof caps.vision === "boolean" ? caps.vision : modalities.length ? modalities.includes("image") : undefined,
    reasoning: typeof caps.reasoning === "boolean" ? caps.reasoning : typeof r.thinking === "boolean" ? r.thinking : undefined,
  };
}

/** Chat-capable models only (OmniRoute also lists embedding, image, audio… models). */
export const isChatModel = (m: OmniModel) => !m.type || !NON_CHAT_TYPES.has(m.type);

export function toCombo(r: any): Combo | undefined {
  const id = str(r?.id);
  const name = str(r?.name);
  if (!id || !name) return undefined;
  const models: ComboStep[] = (Array.isArray(r.models) ? r.models : []).map((s: any) =>
    typeof s === "string" ? { kind: "model", model: s } : { kind: s?.kind === "combo-ref" ? "combo-ref" : "model", model: str(s?.model), comboName: str(s?.comboName), providerId: str(s?.providerId) }
  );
  return {
    id, name, models,
    strategy: str(r.strategy) || "priority",
    isActive: r.isActive !== false,
    isHidden: r.isHidden === true,
    description: str(r.description),
    contextLength: numOr(r.computed_context_length ?? r.context_length),
    updatedAt: str(r.updatedAt),
  };
}

export function toConnection(r: any): Connection | undefined {
  const id = str(r?.id);
  if (!id) return undefined;
  return {
    id,
    provider: str(r.provider) || "unknown",
    name: str(r.name) || str(r.displayName) || str(r.email) || str(r.provider) || id,
    authType: str(r.authType),
    email: str(r.email),
    isActive: r.isActive !== false,
    testStatus: str(r.testStatus),
    lastError: str(r.lastError) ?? null,
    lastTested: str(r.lastTested) ?? null,
    rateLimitedUntil: str(r.rateLimitedUntil) ?? null,
    priority: numOr(r.priority),
  };
}

export function toHealth(j: any): HealthInfo {
  const breakers = Array.isArray(j?.providerBreakers) ? j.providerBreakers : [];
  return {
    status: str(j?.status) || "unknown",
    setupComplete: typeof j?.setupComplete === "boolean" ? j.setupComplete : undefined,
    version: str(j?.version),
    catalogCount: numOr(j?.catalogCount),
    configuredCount: numOr(j?.configuredCount),
    activeCount: numOr(j?.activeCount),
    monitoredCount: numOr(j?.monitoredCount),
    credentialHealth: j?.credentialHealth && typeof j.credentialHealth === "object" ? j.credentialHealth : undefined,
    openBreakers: breakers
      .map((b: any) => ({ provider: str(b?.provider) || str(b?.name) || "?", state: String(b?.state ?? "").toUpperCase() }))
      .filter((b: any) => b.state && b.state !== "CLOSED"),
    lockouts: Array.isArray(j?.lockouts) ? j.lockouts.length : 0,
    activeSessions: numOr(j?.sessions?.activeCount),
  };
}

function toUsageRow(r: any, keyField: string): UsageRow | undefined {
  const key = str(r?.[keyField]) || str(r?.model) || str(r?.provider) || str(r?.name);
  if (!key) return undefined;
  return {
    key,
    provider: str(r.provider),
    requests: numOr(r.requests ?? r.totalRequests ?? r.count) ?? 0,
    cost: numOr(r.cost ?? r.totalCost) ?? 0,
    avgLatencyMs: numOr(r.avgLatencyMs),
    successRatePct: numOr(r.successRatePct),
    totalTokens: numOr(r.totalTokens),
  };
}

export function toUsage(j: any): UsageSummary {
  const s = j?.summary || {};
  const rows = (arr: any, key: string) => (Array.isArray(arr) ? arr.map((r) => toUsageRow(r, key)).filter((r): r is UsageRow => !!r) : []);
  return {
    totalRequests: numOr(s.totalRequests) ?? 0,
    totalCost: numOr(s.totalCost) ?? 0,
    successRatePct: numOr(s.successRatePct),
    avgLatencyMs: numOr(s.avgLatencyMs),
    fallbackCount: numOr(s.fallbackCount),
    byModel: rows(j?.byModel, "model").sort((a, b) => b.cost - a.cost || b.requests - a.requests),
    byProvider: rows(j?.byProvider, "provider").sort((a, b) => b.cost - a.cost || b.requests - a.requests),
    daily: (Array.isArray(j?.dailyTrend) ? j.dailyTrend : [])
      .map((d: any) => ({ date: str(d?.date) || "", requests: numOr(d?.requests) ?? 0, cost: numOr(d?.cost) ?? 0 }))
      .filter((d: any) => d.date),
  };
}

export function toCallLog(r: any): CallLog | undefined {
  const id = str(r?.id);
  if (!id) return undefined;
  return {
    id,
    timestamp: str(r.timestamp) || "",
    status: numOr(r.status) ?? 0,
    model: str(r.model) || "",
    requestedModel: str(r.requestedModel) ?? null,
    provider: str(r.providerDisplay) || str(r.provider) || "",
    account: str(r.account),
    durationMs: numOr(r.duration) ?? 0,
    tokensIn: numOr(r.tokens?.in),
    tokensOut: numOr(r.tokens?.out),
    comboName: str(r.comboName) ?? null,
    error: str(r.error) ?? null,
    correlationId: str(r.correlationId) ?? null,
  };
}

function toQuotaWindow(label: string, r: any): QuotaWindow | undefined {
  if (!r || typeof r !== "object") return undefined;
  const pct = numOr(r.remainingPercentage);
  const total = numOr(r.total);
  const remaining = numOr(r.remaining);
  // Providers report either a percentage or counts; derive whichever is missing.
  const derived = pct ?? (total && remaining !== undefined ? (remaining / total) * 100 : undefined);
  return {
    label: str(r.displayName) || label,
    used: numOr(r.used),
    total,
    remaining,
    remainingPercentage: derived === undefined ? undefined : Math.max(0, Math.min(100, derived)),
    resetAt: str(r.resetAt) ?? null,
    unlimited: r.unlimited === true,
    windowSeconds: numOr(r.windowSeconds),
    currency: str(r.currency),
    isPercentageOnly: r.isPercentageOnly === true,
  };
}

const windowList = (o: any): QuotaWindow[] =>
  o && typeof o === "object" && !Array.isArray(o)
    ? Object.entries(o).map(([k, v]) => toQuotaWindow(k, v)).filter((w): w is QuotaWindow => !!w)
    : [];

export function toProviderLimits(connectionId: string, r: any): ProviderLimits | undefined {
  if (!r || typeof r !== "object") return undefined;
  return {
    connectionId,
    windows: windowList(r.quotas),
    modelWindows: windowList(r.modelQuotas),
    // `plan` is a string for most providers but an object for some; only strings are shown.
    plan: str(r.plan),
    message: str(r.message),
    fetchedAt: str(r.fetchedAt),
    source: str(r.source),
  };
}

/**
 * Usable headroom, matching OmniRoute's `effectiveRemainingPercent`: the gateway reserves
 * `cutoff`% so a connection reads as exhausted exactly when routing to it stops.
 */
export function effectiveRemaining(rawPercent: number | undefined, cutoffPercent: number): number | undefined {
  if (rawPercent === undefined || !Number.isFinite(rawPercent)) return undefined;
  const remaining = Math.max(0, Math.min(100, rawPercent));
  const cutoff = Math.max(0, Math.min(99, cutoffPercent));
  if (remaining <= cutoff) return 0;
  return ((remaining - cutoff) / (100 - cutoff)) * 100;
}

/** The window a user should be warned about first: lowest effective headroom, ignoring unlimited ones. */
export function worstWindow(limits: ProviderLimits | undefined, cutoffPercent: number): QuotaWindow | undefined {
  let worst: QuotaWindow | undefined;
  let worstPct = Infinity;
  for (const w of limits?.windows ?? []) {
    if (w.unlimited) continue;
    const pct = effectiveRemaining(w.remainingPercentage, cutoffPercent);
    if (pct === undefined) continue;
    if (pct < worstPct) {
      worstPct = pct;
      worst = w;
    }
  }
  return worst;
}

export class OmniClient {
  constructor(private readonly _opts: ClientOptions) {}

  get baseUrl() {
    return normalizeBaseUrl(this._opts.baseUrl());
  }
  /** OpenAI-compatible base URL for other tools. */
  get openAiBaseUrl() {
    return `${this.baseUrl}/v1`;
  }

  private async _fetch(path: string, init: RequestInit & { auth: "none" | "api" | "manage"; timeoutMs?: number }): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", ...(init.headers as Record<string, string>) };
    if (this._opts.userAgent) headers["User-Agent"] = this._opts.userAgent;
    if (init.auth === "api") {
      const key = await this._opts.credentials.apiKey();
      if (key) headers.Authorization = `Bearer ${key}`;
    } else if (init.auth === "manage") {
      Object.assign(headers, await this._opts.credentials.managementHeaders());
    }
    if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const timeout = init.timeoutMs ?? this._opts.timeoutMs();
    const signal = init.signal ?? AbortSignal.timeout(timeout);
    return fetch(this.baseUrl + path, { ...init, headers, signal, redirect: "manual" });
  }

  private async _json<T = any>(path: string, init: RequestInit & { auth: "none" | "api" | "manage"; timeoutMs?: number } = { auth: "manage" }): Promise<T> {
    const res = await this._fetch(path, init);
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, text), path);
    if (!text) return {} as T;
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(res.status, `Unexpected non-JSON response from ${path}`, path);
    }
  }

  // ------------------------------------------------------------- public

  /** True when the server answers /api/health (no auth needed). */
  async ping(timeoutMs = 3000): Promise<boolean> {
    try {
      const res = await this._fetch("/api/health", { auth: "none", timeoutMs });
      await res.text().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Signs in with the dashboard password; returns the `auth_token` cookie value. */
  async login(password: string): Promise<string> {
    const res = await this._fetch("/api/auth/login", { auth: "none", method: "POST", body: JSON.stringify({ password }) });
    const text = await res.text();
    if (!res.ok) {
      let msg = errorMessage(res.status, text);
      if (res.status === 403 && /needsSetup/.test(text)) msg = "OmniRoute has not been set up yet — finish onboarding in the web dashboard first.";
      throw new ApiError(res.status, msg, "/api/auth/login");
    }
    const cookies = typeof (res.headers as any).getSetCookie === "function" ? (res.headers as any).getSetCookie() : [res.headers.get("set-cookie") || ""];
    for (const c of cookies) {
      const m = /(?:^|[;,]\s*)auth_token=([^;,\s]+)/.exec(c);
      if (m && m[1]) return m[1];
    }
    throw new ApiError(res.status, "Signed in, but the server did not return a session cookie.", "/api/auth/login");
  }

  async logout(): Promise<void> {
    await this._json("/api/auth/logout", { auth: "manage", method: "POST" }).catch(() => undefined);
  }

  // ---------------------------------------------------------- inference

  async listModels(): Promise<OmniModel[]> {
    const j = await this._json("/v1/models", { auth: "api" });
    return list(j, "data", "models").map(toModel).filter((m): m is OmniModel => !!m);
  }

  /** Starts a streaming chat completion. Caller owns the abort signal (no timeout for chats). */
  async chat(body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    return this._fetch("/v1/chat/completions", { auth: "api", method: "POST", body: JSON.stringify(body), headers, signal });
  }

  // --------------------------------------------------------- management

  async health(): Promise<HealthInfo> {
    return toHealth(await this._json("/api/monitoring/health", { auth: "manage" }));
  }

  /** Whether our management credentials are accepted (the public health payload lacks catalogCount). */
  async canManage(): Promise<boolean> {
    try {
      await this._json("/api/combos?limit=1", { auth: "manage" });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) return false;
      throw err;
    }
  }

  async version(): Promise<{ current?: string; latest?: string; updateAvailable?: boolean }> {
    const j = await this._json("/api/system/version", { auth: "manage" });
    return { current: str(j?.current), latest: str(j?.latest), updateAvailable: j?.updateAvailable === true };
  }

  async combos(): Promise<Combo[]> {
    return list(await this._json("/api/combos?limit=500"), "combos", "data").map(toCombo).filter((c): c is Combo => !!c);
  }
  async createCombo(input: { name: string; strategy: string; models: string[]; description?: string }): Promise<Combo | undefined> {
    const body = { name: input.name, strategy: input.strategy, models: input.models.map((model) => ({ kind: "model", model })), ...(input.description ? { description: input.description } : {}) };
    return toCombo(await this._json("/api/combos", { auth: "manage", method: "POST", body: JSON.stringify(body) }));
  }
  async updateCombo(id: string, patch: Record<string, unknown>): Promise<Combo | undefined> {
    return toCombo(await this._json(`/api/combos/${encodeURIComponent(id)}`, { auth: "manage", method: "PATCH", body: JSON.stringify(patch) }));
  }
  async deleteCombo(id: string): Promise<void> {
    await this._json(`/api/combos/${encodeURIComponent(id)}`, { auth: "manage", method: "DELETE" });
  }

  async connections(): Promise<Connection[]> {
    return list(await this._json("/api/providers?limit=500"), "connections", "data").map(toConnection).filter((c): c is Connection => !!c);
  }
  async testConnection(id: string): Promise<{ valid: boolean; error?: string; latencyMs?: number }> {
    const j = await this._json(`/api/providers/${encodeURIComponent(id)}/test`, { auth: "manage", method: "POST", body: "{}", timeoutMs: 60000 });
    return { valid: j?.valid === true, error: str(j?.error) || str(j?.warning), latencyMs: numOr(j?.latencyMs) };
  }
  async setConnectionActive(id: string, isActive: boolean): Promise<void> {
    await this._json(`/api/providers/${encodeURIComponent(id)}`, { auth: "manage", method: "PUT", body: JSON.stringify({ isActive }) });
  }

  async apiKeys(): Promise<ApiKeyInfo[]> {
    return list(await this._json("/api/keys?limit=500"), "keys", "data")
      .filter((k) => str(k?.id))
      .map((k) => ({ id: k.id, name: str(k.name) || k.id, key: str(k.key) || "", isActive: k.isActive !== false, scopes: Array.isArray(k.scopes) ? k.scopes : [], createdAt: str(k.createdAt), lastUsedAt: str(k.lastUsedAt) }));
  }
  /** Creates a key and returns its plaintext value — the only time OmniRoute reveals it. */
  async createApiKey(name: string, scopes: string[] = []): Promise<{ id?: string; key: string }> {
    const j = await this._json("/api/keys", { auth: "manage", method: "POST", body: JSON.stringify({ name, ...(scopes.length ? { scopes } : {}) }) });
    const key = str(j?.key);
    if (!key) throw new ApiError(500, "The server did not return the new key.", "/api/keys");
    return { id: str(j?.id), key };
  }
  async deleteApiKey(id: string): Promise<void> {
    await this._json(`/api/keys/${encodeURIComponent(id)}`, { auth: "manage", method: "DELETE" });
  }

  async usage(range = "30d"): Promise<UsageSummary> {
    return toUsage(await this._json(`/api/usage/analytics?range=${encodeURIComponent(range)}`));
  }
  async autoRouting(): Promise<AutoRoutingStats> {
    const j = await this._json("/api/analytics/auto-routing");
    return {
      totalRequests: numOr(j?.totalRequests) ?? 0,
      variants: j?.variantBreakdown && typeof j.variantBreakdown === "object" ? j.variantBreakdown : {},
      topProviders: list(j?.topProviders).map((p: any) => ({ provider: String(p?.provider ?? "?"), count: numOr(p?.count) ?? 0 })),
    };
  }
  async callLogs(query: { correlationId?: string; limit?: number } = {}): Promise<CallLog[]> {
    const q = new URLSearchParams({ limit: String(query.limit ?? 50), excludeTests: "1" });
    if (query.correlationId) q.set("correlationId", query.correlationId);
    return list(await this._json(`/api/usage/call-logs?${q}`), "logs", "data").map(toCallLog).filter((l): l is CallLog => !!l);
  }

  /**
   * Cached provider quota. Read-only: the gateway refreshes on its own schedule, and a
   * POST here would hit every upstream, so we never trigger that from a poll.
   */
  async providerLimits(): Promise<QuotaSnapshot> {
    const j = await this._json("/api/usage/provider-limits");
    const caches = j?.caches && typeof j.caches === "object" ? j.caches : {};
    const byConnection: Record<string, ProviderLimits> = {};
    for (const [id, entry] of Object.entries(caches)) {
      const limits = toProviderLimits(id, entry);
      if (limits && (limits.windows.length || limits.modelWindows.length || limits.message)) byConnection[id] = limits;
    }
    return {
      byConnection,
      intervalMinutes: numOr(j?.intervalMinutes),
      lastAutoSyncAt: str(j?.lastAutoSyncAt),
      cutoffPercent: QUOTA_CUTOFF_DEFAULT,
      warnPercent: QUOTA_WARN_DEFAULT,
    };
  }

  /** Reads the operator's quota cutoff/warn thresholds; falls back to OmniRoute's defaults. */
  async quotaThresholds(): Promise<{ cutoffPercent: number; warnPercent: number }> {
    const j = await this._json("/api/settings");
    const q = (j?.resilience?.quotaPreflight ?? j?.quotaPreflight) as any;
    return {
      cutoffPercent: numOr(q?.defaultThresholdPercent) ?? QUOTA_CUTOFF_DEFAULT,
      warnPercent: numOr(q?.warnThresholdPercent) ?? QUOTA_WARN_DEFAULT,
    };
  }

  async cacheStats(): Promise<Record<string, unknown>> {
    const j = await this._json("/api/cache/stats");
    return j?.semanticCache && typeof j.semanticCache === "object" ? j.semanticCache : j && typeof j === "object" ? j : {};
  }
  async clearCache(): Promise<void> {
    await this._json("/api/cache/stats", { auth: "manage", method: "DELETE" });
  }

  /** Resets provider circuit breakers and model lockouts. */
  async resetBreakers(): Promise<number | undefined> {
    const j = await this._json("/api/resilience/reset", { auth: "manage", method: "POST", body: "{}" });
    return numOr(j?.resetCount);
  }
  async cooldowns(): Promise<Cooldown[]> {
    return list(await this._json("/api/resilience/model-cooldowns"), "items", "cooldowns").map((c: any) => ({
      provider: String(c?.provider ?? "?"), model: String(c?.model ?? "?"), remainingMs: numOr(c?.remainingMs), reason: str(c?.reason),
    }));
  }
  async clearCooldowns(): Promise<void> {
    await this._json("/api/resilience/model-cooldowns", { auth: "manage", method: "DELETE", body: JSON.stringify({ all: true }) });
  }

  async compression(): Promise<CompressionConfig> {
    const j = await this._json("/api/settings/compression");
    return { enabled: j?.enabled === true, defaultMode: str(j?.defaultMode) || "off", autoTriggerMode: str(j?.autoTriggerMode), autoTriggerTokens: numOr(j?.autoTriggerTokens) };
  }
  async setCompression(patch: Partial<CompressionConfig>): Promise<CompressionConfig> {
    await this._json("/api/settings/compression", { auth: "manage", method: "PUT", body: JSON.stringify(patch) });
    return this.compression();
  }

  async settings(): Promise<Record<string, unknown>> {
    return this._json("/api/settings");
  }
  async patchSettings(patch: Record<string, unknown>): Promise<void> {
    await this._json("/api/settings", { auth: "manage", method: "PATCH", body: JSON.stringify(patch) });
  }

  async mcpStatus(): Promise<McpStatus> {
    const j = await this._json("/api/mcp/status");
    return {
      enabled: j?.enabled === true || j?.online === true,
      online: j?.online === true || j?.status === "online",
      transport: str(j?.transport),
      calls24h: numOr(j?.activity?.totalCalls24h),
      successRate: numOr(j?.activity?.successRate),
      lastCallTool: str(j?.activity?.lastCallTool),
    };
  }
  async mcpTools(): Promise<{ name: string; description?: string }[]> {
    return list(await this._json("/api/mcp/tools"), "tools").map((t: any) => ({ name: String(t?.name ?? "?"), description: str(t?.description) }));
  }

  async restart(): Promise<void> {
    await this._json("/api/restart", { auth: "manage", method: "POST", body: "{}" });
  }
  async shutdown(): Promise<void> {
    await this._json("/api/shutdown", { auth: "manage", method: "POST", body: "{}" });
  }
}
