// Sample DashboardState used by the jsdom dashboard tests and the screenshot script.
const now = Date.now();
const iso = (ago) => new Date(now - ago).toISOString();
const m = (id, kind, ownedBy, extra = {}) => ({ id, kind, ownedBy, name: id, ...extra });

function dashboardState(overrides = {}) {
  const snap = {
    state: "online",
    baseUrl: "http://localhost:20128",
    canManage: true,
    auth: { hasApiKey: true, hasManagementKey: false, signedIn: true },
    refreshedAt: now,
    health: { status: "healthy", setupComplete: true, catalogCount: 372, configuredCount: 4, activeCount: 3, monitoredCount: 3, openBreakers: [{ provider: "groq", state: "OPEN" }], lockouts: 1, activeSessions: 3 },
    version: { current: "3.8.52", latest: "3.8.53", updateAvailable: true },
    models: [
      m("auto", "auto", "combo", { contextLength: 128000, toolCalling: true, reasoning: true }),
      m("auto/coding", "auto", "combo", { contextLength: 128000, toolCalling: true, reasoning: true }),
      m("auto/fast", "auto", "combo", { contextLength: 128000, toolCalling: true }),
      m("coding", "combo", "combo", { description: "Sonnet first, GPT as backup", contextLength: 400000 }),
      m("anthropic/claude-sonnet-5-5", "model", "anthropic", { name: "Claude Sonnet 5.5", contextLength: 1000000, toolCalling: true, vision: true, reasoning: true }),
      m("openai/gpt-5.4", "model", "openai", { name: "GPT-5.4", contextLength: 400000, toolCalling: true, vision: true, reasoning: true }),
      m("groq/llama-4-scout", "model", "groq", { name: "Llama 4 Scout", contextLength: 131072, toolCalling: true }),
      m('evil/<img src=x onerror="window.pwned=1">', "model", "evil<b>", { name: "<script>bad()</script>" }),
      m("openai/text-embedding-3-small", "model", "openai", { type: "embedding" }),
    ],
    combos: [
      { id: "c1", name: "coding", strategy: "priority", isActive: true, isHidden: false, description: "Sonnet first, GPT as backup", contextLength: 400000, models: [{ kind: "model", model: "anthropic/claude-sonnet-5-5", providerId: "anthropic" }, { kind: "model", model: "openai/gpt-5.4", providerId: "openai" }] },
      { id: "c2", name: "cheap-chat", strategy: "cost-optimized", isActive: false, isHidden: false, models: [{ kind: "model", model: "groq/llama-4-scout", providerId: "groq" }, { kind: "combo-ref", comboName: "coding" }] },
    ],
    connections: [
      { id: "p1", provider: "anthropic", name: "Anthropic main", authType: "apikey", isActive: true, testStatus: "active", lastTested: iso(36e5), priority: 1 },
      { id: "p2", provider: "openai", name: "OpenAI", authType: "apikey", isActive: true, testStatus: "active", lastTested: null, priority: 2 },
      { id: "p3", provider: "groq", name: "Groq free", authType: "apikey", isActive: true, testStatus: "error", lastError: "401 Invalid API key", lastTested: iso(72e5), priority: 3 },
      { id: "p4", provider: "claude", name: "Claude Code", authType: "oauth", email: "dev@example.com", isActive: false, testStatus: "unknown", priority: 4 },
    ],
    keys: [{ id: "k1", name: "VS Code", key: "sk-omni-****test", isActive: true, scopes: ["mcp:connect"] }],
    usage: {
      totalRequests: 258, totalCost: 1.8432, successRatePct: 97.3, avgLatencyMs: 1010, fallbackCount: 9,
      byModel: [
        { key: "anthropic/claude-sonnet-5-5", provider: "anthropic", requests: 182, cost: 1.41, avgLatencyMs: 980, successRatePct: 99 },
        { key: "openai/gpt-5.4", provider: "openai", requests: 64, cost: 0.4302, avgLatencyMs: 1220, successRatePct: 97 },
        { key: "groq/llama-4-scout", provider: "groq", requests: 12, cost: 0.003, avgLatencyMs: 310, successRatePct: 75 },
      ],
      byProvider: [
        { key: "anthropic", requests: 182, cost: 1.41, avgLatencyMs: 980, successRatePct: 99 },
        { key: "openai", requests: 64, cost: 0.4302, avgLatencyMs: 1220, successRatePct: 97 },
        { key: "groq", requests: 12, cost: 0.003, avgLatencyMs: 310, successRatePct: 75 },
      ],
      daily: Array.from({ length: 14 }, (_, i) => ({ date: new Date(now - (13 - i) * 864e5).toISOString().slice(0, 10), requests: 8 + ((i * 7) % 23), cost: 0.05 + ((i * 13) % 17) / 100 })),
    },
    autoRouting: { totalRequests: 140, variants: { default: 60, coding: 70, fast: 10 }, topProviders: [{ provider: "anthropic", count: 110 }, { provider: "openai", count: 30 }] },
    mcp: { enabled: true, online: true, transport: "streamable-http", calls24h: 37, successRate: 0.97, lastCallTool: "omniroute_get_health" },
    cache: { size: 42, maxSize: 500, hits: 31, hitRate: 0.23 },
    cooldowns: [{ provider: "groq", model: "llama-4-scout", remainingMs: 45000, reason: "rate_limited" }],
    compression: { enabled: true, defaultMode: "standard" },
    quota: {
      cutoffPercent: 5,
      warnPercent: 20,
      intervalMinutes: 30,
      lastAutoSyncAt: iso(3e5),
      byConnection: {
        p1: {
          connectionId: "p1", plan: "max_20x", fetchedAt: iso(3e5), source: "scheduled", modelWindows: [],
          windows: [
            { label: "session (5h)", used: 31, total: 100, remaining: 69, remainingPercentage: 69, resetAt: new Date(now + 2 * 36e5).toISOString(), unlimited: false },
            { label: "weekly (7d)", used: 94, total: 100, remaining: 6, remainingPercentage: 6, resetAt: new Date(now + 5 * 864e5).toISOString(), unlimited: false },
          ],
        },
        p2: {
          connectionId: "p2", fetchedAt: iso(6e5), source: "manual", modelWindows: [],
          windows: [
            { label: "Balance (USD)", used: 0, total: 0, remaining: 12.5, remainingPercentage: 0, resetAt: null, unlimited: true, currency: "USD" },
            // Window labels come from the provider, so they must be escaped like model names.
            { label: '<img src=x onerror="window.pwned=1">', remainingPercentage: 3, resetAt: null, unlimited: false, isPercentageOnly: true },
          ],
        },
        p3: { connectionId: "p3", message: "Quota reporting is not supported for this provider.", fetchedAt: iso(9e5), windows: [], modelWindows: [] },
      },
    },
    recentCalls: [
      { id: "l1", timestamp: iso(6e4), status: 200, model: "anthropic/claude-sonnet-5-5", requestedModel: "auto/coding", provider: "Anthropic", account: "Anthropic main", durationMs: 412, tokensIn: 120, tokensOut: 24, comboName: "auto/coding", error: null },
      { id: "l2", timestamp: iso(3e5), status: 429, model: "groq/llama-4-scout", requestedModel: "coding", provider: "groq", durationMs: 95, comboName: "coding", error: "rate limited" },
    ],
    routing: [
      { at: now - 6e4, ok: true, requested: "auto/coding", served: "anthropic/claude-sonnet-5-5", provider: "Anthropic", latencyMs: 412, decision: "strategy=auto; provider=anthropic; latency_ms=412", correlationId: "c-1", tokensIn: 120, tokensOut: 24 },
      { at: now - 3e5, ok: true, requested: "coding", served: "openai/gpt-5.4", provider: "openai", latencyMs: 1290, fallbackAttempts: 1, comboName: "coding", costUsd: 0.0042 },
      { at: now - 6e5, ok: false, requested: "auto/fast", error: "OmniRoute: HTTP 503: All providers in combo exhausted." },
    ],
  };
  const state = {
    snap: { ...snap, ...(overrides.snap || {}) },
    settings: {
      "copilot.enabled": true, "copilot.includeAutoModels": true, "copilot.includeCombos": true, "copilot.models": ["anthropic/claude-sonnet-5-5"],
      "chat.compression": "server", "chat.bypassCache": false, "chat.disableMemory": false, "chat.showReasoning": true, "chat.routingNotice": "statusBar",
      "mcp.enabled": true, "server.launchMode": "npx", "server.localhostOnly": true, "server.autoStart": false,
      ...(overrides.settings || {}),
    },
    offered: overrides.offered || ["auto", "auto/coding", "auto/fast", "coding", "anthropic/claude-sonnet-5-5"],
    launchedHere: false,
  };
  return state;
}

module.exports = { dashboardState };
