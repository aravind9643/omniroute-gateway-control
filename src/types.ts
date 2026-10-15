import type { RoutingInfo } from "./stream";

/** Defaults from OmniRoute's resilience settings (quotaPreflight). */
export const QUOTA_CUTOFF_DEFAULT = 2;
export const QUOTA_WARN_DEFAULT = 20;

// Shapes the extension uses, normalized from OmniRoute's API (see client.ts for the raw → normalized mapping).

export type ModelKind = "auto" | "combo" | "model";

export interface OmniModel {
  id: string;
  kind: ModelKind;
  /** Provider id for catalog models ("anthropic"), "combo" for auto/* and combos. */
  ownedBy: string;
  name: string;
  description?: string;
  /** Non-chat models (embedding, image, audio…) are listed but never offered to Copilot. */
  type?: string;
  contextLength?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

export interface ComboStep {
  kind: "model" | "combo-ref";
  model?: string;
  comboName?: string;
  providerId?: string;
}

export interface Combo {
  id: string;
  name: string;
  strategy: string;
  models: ComboStep[];
  isActive: boolean;
  isHidden: boolean;
  description?: string;
  contextLength?: number;
  updatedAt?: string;
}

export interface Connection {
  id: string;
  provider: string;
  name: string;
  authType?: string;
  email?: string;
  isActive: boolean;
  testStatus?: string;
  lastError?: string | null;
  lastTested?: string | null;
  rateLimitedUntil?: string | null;
  priority?: number;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  /** Masked by the server ("sk-omni-****abcd"). */
  key: string;
  isActive: boolean;
  scopes: string[];
  createdAt?: string;
  lastUsedAt?: string;
}

export interface HealthInfo {
  status: string;
  setupComplete?: boolean;
  version?: string;
  catalogCount?: number;
  configuredCount?: number;
  activeCount?: number;
  monitoredCount?: number;
  credentialHealth?: Record<string, number>;
  openBreakers: { provider: string; state: string }[];
  lockouts: number;
  activeSessions?: number;
}

export interface UsageRow {
  key: string;
  provider?: string;
  requests: number;
  cost: number;
  avgLatencyMs?: number;
  successRatePct?: number;
  totalTokens?: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalCost: number;
  successRatePct?: number;
  avgLatencyMs?: number;
  fallbackCount?: number;
  byModel: UsageRow[];
  byProvider: UsageRow[];
  daily: { date: string; requests: number; cost: number }[];
}

export interface AutoRoutingStats {
  totalRequests: number;
  variants: Record<string, number>;
  topProviders: { provider: string; count: number }[];
}

export interface McpStatus {
  enabled: boolean;
  online: boolean;
  transport?: string;
  calls24h?: number;
  successRate?: number;
  lastCallTool?: string;
}

export interface CallLog {
  id: string;
  timestamp: string;
  status: number;
  model: string;
  requestedModel?: string | null;
  provider: string;
  account?: string;
  durationMs: number;
  tokensIn?: number;
  tokensOut?: number;
  comboName?: string | null;
  error?: string | null;
  correlationId?: string | null;
}

export interface CompressionConfig {
  enabled: boolean;
  defaultMode: string;
  autoTriggerMode?: string;
  autoTriggerTokens?: number;
}

export interface Cooldown {
  provider: string;
  model: string;
  remainingMs?: number;
  reason?: string;
}

/**
 * One quota window reported by an upstream provider, e.g. "session (5h)", "weekly (7d)",
 * "credit", or a model id. Window labels are provider-defined and free-form.
 *
 * `remainingPercentage` is the RAW upstream value. OmniRoute stops routing to a connection
 * while its remaining quota is at or below a cutoff threshold, so the usable headroom is
 * lower — see `effectiveRemaining` in client.ts.
 */
export interface QuotaWindow {
  /** Provider-defined window key; `displayName` when the provider supplies a nicer label. */
  label: string;
  used?: number;
  total?: number;
  remaining?: number;
  /** Raw remaining percentage (0-100) as reported upstream. */
  remainingPercentage?: number;
  /** ISO timestamp when the window resets; null for windows that never reset (e.g. a balance). */
  resetAt?: string | null;
  /** True for windows with no cap — `total`/`remaining` are 0 and must not read as exhausted. */
  unlimited: boolean;
  windowSeconds?: number;
  /** Set for credit/balance windows, e.g. "USD". */
  currency?: string;
  /** The provider reports only a percentage, so `used`/`total` are not meaningful counts. */
  isPercentageOnly?: boolean;
}

/** Cached provider quota for one connection (GET /api/usage/provider-limits). */
export interface ProviderLimits {
  /** Connection id, matching `Connection.id`. */
  connectionId: string;
  windows: QuotaWindow[];
  /** Per-model windows, kept separate from account-wide ones. */
  modelWindows: QuotaWindow[];
  /** Plan name when the provider reports one as a string. */
  plan?: string;
  /** Why no quota is available, when the provider said so. */
  message?: string;
  /** ISO timestamp of the cached reading. */
  fetchedAt?: string;
  source?: string;
}

export interface QuotaSnapshot {
  byConnection: Record<string, ProviderLimits>;
  /** Minutes between the gateway's automatic refreshes. */
  intervalMinutes?: number;
  lastAutoSyncAt?: string;
  /** Remaining-% at or below which OmniRoute stops routing (default 2). */
  cutoffPercent: number;
  /** Remaining-% at or below which the gateway warns (default 20). */
  warnPercent: number;
}

/** Known combo strategies (OmniRoute validates the final list server-side). */
export const COMBO_STRATEGIES = [
  "priority",
  "weighted",
  "round-robin",
  "fill-first",
  "p2c",
  "random",
  "latency",
  "sticky",
  "cost-optimized",
  "fusion",
  "quota-share",
  "context-relay",
] as const;

export const COMPRESSION_MODES = ["off", "lite", "standard", "aggressive", "ultra", "rtk", "stacked"] as const;

/** offline: no answer from /api/health · needsKey: up, but /v1 rejects us · online: /v1 works. */
export type ConnState = "offline" | "needsKey" | "online";

export interface RoutingRecord extends RoutingInfo {
  at: number;
  requested: string;
  served?: string;
  durationMs?: number;
  ok: boolean;
  error?: string;
  correlationId?: string;
  account?: string;
  comboName?: string | null;
}

export interface Snapshot {
  state: ConnState;
  baseUrl: string;
  canManage: boolean;
  auth: { hasApiKey: boolean; hasManagementKey: boolean; signedIn: boolean };
  error?: string;
  refreshedAt?: number;
  health?: HealthInfo;
  version?: { current?: string; latest?: string; updateAvailable?: boolean };
  models: OmniModel[];
  combos: Combo[];
  connections: Connection[];
  keys: ApiKeyInfo[];
  usage?: UsageSummary;
  autoRouting?: AutoRoutingStats;
  mcp?: McpStatus;
  cache?: Record<string, unknown>;
  cooldowns: Cooldown[];
  compression?: CompressionConfig;
  recentCalls: CallLog[];
  routing: RoutingRecord[];
  quota?: QuotaSnapshot;
}
