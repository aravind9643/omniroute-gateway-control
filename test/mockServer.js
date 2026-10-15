// Offline OmniRoute stand-in for tests and F5 debugging: node test/mockServer.js [port]
// Shapes follow OmniRoute's route handlers (see AGENTS.md "OmniRoute API facts").
//   /v1/*   inference — Bearer API_KEY
//   /api/*  management — session cookie (login with PASSWORD) or Bearer ADMIN_KEY ("manage" scope)
//   /api/mcp/stream also accepts MCP_KEY ("mcp:connect" scope)
// Like the real server, streamed chats carry only X-Correlation-Id (+ decision); details come from call logs.
// Only Node stdlib.
const http = require("http");
const crypto = require("crypto");

const API_KEY = "sk-omni-test";
const ADMIN_KEY = "sk-omni-admin";
const PASSWORD = "admin";
const SESSION = "mock-session-token";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function createState() {
  return {
    combos: [
      {
        id: "c1", name: "coding", strategy: "priority", isActive: true, isHidden: false, sortOrder: 0, config: {}, description: "Sonnet first, GPT as backup",
        models: [{ kind: "model", model: "anthropic/claude-sonnet-5-5", providerId: "anthropic" }, { kind: "model", model: "openai/gpt-5.4", providerId: "openai" }],
        createdAt: iso(864e5), updatedAt: iso(864e5), computed_context_length: 400000,
      },
      {
        id: "c2", name: "cheap-chat", strategy: "cost-optimized", isActive: false, isHidden: false, sortOrder: 1, config: {},
        models: [{ kind: "model", model: "groq/llama-4-scout", providerId: "groq" }, { kind: "combo-ref", comboName: "coding" }],
        createdAt: iso(864e5), updatedAt: iso(864e5), computed_context_length: 131072,
      },
    ],
    connections: [
      { id: "p1", provider: "anthropic", authType: "apikey", name: "Anthropic main", priority: 1, isActive: true, testStatus: "active", lastTested: iso(36e5), lastError: null, rateLimitedUntil: null, apiKey: "sk-ant-****9f2c" },
      { id: "p2", provider: "openai", authType: "apikey", name: "OpenAI", priority: 2, isActive: true, testStatus: "active", lastTested: null, lastError: null, rateLimitedUntil: null, apiKey: "sk-p****a1b2" },
      { id: "p3", provider: "groq", authType: "apikey", name: "Groq free", priority: 3, isActive: true, testStatus: "error", lastTested: iso(72e5), lastError: "401 Invalid API key", rateLimitedUntil: null, apiKey: "gsk_****0000" },
      { id: "p4", provider: "claude", authType: "oauth", name: "Claude Code", email: "dev@example.com", priority: 4, isActive: false, testStatus: "unknown", lastTested: null, lastError: null, rateLimitedUntil: null },
    ],
    keys: [
      { id: "k1", name: "VS Code", key: "sk-omni-****test", isActive: true, createdAt: iso(864e5), lastUsedAt: iso(6e4), scopes: ["mcp:connect"], modelAccessMode: "all" },
      { id: "k2", name: "CI bot", key: "sk-omni-****ci01", isActive: false, createdAt: iso(1728e5), scopes: [], modelAccessMode: "restricted" },
    ],
    cache: { size: 42, maxSize: 500, hits: 31, misses: 104, hitRate: 0.23 },
    cooldowns: [{ provider: "groq", model: "llama-4-scout", remainingMs: 45000, reason: "rate_limited" }],
    breakersReset: 0,
    compression: { enabled: true, defaultMode: "standard", autoTriggerMode: "off", autoTriggerTokens: 0, cacheMinutes: 30 },
    settings: { mcpEnabled: true, mcpTransport: "streamable-http", semanticCacheEnabled: true, hideAutoCombos: false, excludeTosAvoid: true },
    // Shapes copied from a real OmniRoute providerLimitsCache: free-form window labels, a
    // percentage-only window, an unlimited balance (total/remaining 0) and a plain message.
    providerLimits: {
      p1: {
        quotas: {
          "session (5h)": { used: 31, total: 100, remaining: 69, remainingPercentage: 69, resetAt: new Date(Date.now() + 2 * 36e5).toISOString(), unlimited: false, windowSeconds: 18000 },
          "weekly (7d)": { used: 94, total: 100, remaining: 6, remainingPercentage: 6, resetAt: new Date(Date.now() + 5 * 864e5).toISOString(), unlimited: false },
        },
        modelQuotas: {},
        plan: "default_raven",
        message: null,
        fetchedAt: iso(3e5),
        source: "scheduled",
      },
      p2: {
        quotas: {
          credit: { used: 0, total: 0, remaining: 0, remainingPercentage: 0, resetAt: null, unlimited: true, currency: "USD", displayName: "Balance (USD)" },
          "premium_interactions": { used: 0, total: 0, remaining: 0, remainingPercentage: 1, resetAt: null, unlimited: false, isPercentageOnly: true },
        },
        modelQuotas: {},
        plan: null,
        message: null,
        fetchedAt: iso(6e5),
        source: "manual",
      },
      p3: { quotas: null, modelQuotas: {}, plan: null, message: "Quota reporting is not supported for this provider.", fetchedAt: iso(9e5), source: "scheduled" },
    },
    callLogs: [],
    shutdownCalls: 0,
    restartCalls: 0,
    lastChat: null,
    mcpRequests: 0,
  };
}
let S = createState();

const AUTO = ["auto", "auto/coding", "auto/fast", "auto/cheap", "auto/smart"];
const MODELS = [
  { id: "anthropic/claude-sonnet-5-5", owned_by: "anthropic", context_length: 1000000, max_output_tokens: 128000, capabilities: { tool_calling: true, vision: true, reasoning: true }, input_modalities: ["text", "image"] },
  { id: "openai/gpt-5.4", owned_by: "openai", context_length: 400000, max_output_tokens: 128000, capabilities: { tool_calling: true, vision: true, reasoning: true } },
  { id: "groq/llama-4-scout", owned_by: "groq", context_length: 131072, capabilities: { tool_calling: true, vision: false } },
  { id: "openai/text-embedding-3-small", owned_by: "openai", type: "embedding" },
];

function modelList() {
  const base = { object: "model", created: 1760000000, permission: [], parent: null };
  const data = [
    ...AUTO.map((id) => ({ ...base, id, root: id, owned_by: "combo", context_length: 128000, max_input_tokens: 120000, max_output_tokens: 8192, capabilities: { tool_calling: true, reasoning: true, thinking: true, temperature: true } })),
    ...S.combos.filter((c) => c.isActive !== false && !c.isHidden).map((c) => ({ ...base, id: c.name, root: c.name, owned_by: "combo", display_name: c.displayName, description: c.description, context_length: c.computed_context_length })),
    ...MODELS.map((x) => ({ ...base, root: x.id, ...x })),
  ];
  return { object: "list", data };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
const hasSession = (req) => (req.headers.cookie || "").includes(`auth_token=${SESSION}`);
const isManager = (req) => hasSession(req) || bearer(req) === ADMIN_KEY;

function chat(req, res, body) {
  S.lastChat = { body, headers: req.headers };
  const requested = body.model || "auto";
  const combo = S.combos.find((c) => c.name === requested);
  const served = requested.startsWith("auto") || combo ? "anthropic/claude-sonnet-5-5" : requested;
  const provider = served.split("/")[0];
  const prompt = JSON.stringify(body.messages || []);
  const correlationId = req.headers["x-correlation-id"] || crypto.randomUUID();
  if (/please fail/.test(prompt)) return send(res, 503, { error: { message: "All providers in combo exhausted", type: "upstream_error" } }, { "X-Correlation-Id": correlationId });

  S.callLogs.unshift({
    id: crypto.randomUUID(), timestamp: iso(), method: "POST", path: "/v1/chat/completions", status: 200, model: served, requestedModel: requested,
    provider, providerDisplay: provider === "anthropic" ? "Anthropic" : provider, account: "Anthropic main", connectionId: "p1", duration: 412,
    tokens: { in: 120, out: 24 }, addedWaitMs: null, addedWaitCause: null, cacheSource: null, sourceFormat: "openai", targetFormat: "claude",
    apiKeyId: "k1", apiKeyName: "VS Code", comboName: combo ? combo.name : requested.startsWith("auto") ? requested : null, error: null, correlationId,
  });
  const headers = {
    "Content-Type": "text/event-stream",
    "X-Correlation-Id": correlationId,
    "X-OmniRoute-Decision": `strategy=${combo ? combo.strategy : requested.startsWith("auto") ? "auto" : "direct"}; provider=${provider}; latency_ms=412`,
  };
  if (req.headers["x-omniroute-compression"]) headers["X-OmniRoute-Compression"] = req.headers["x-omniroute-compression"];
  res.writeHead(200, headers);
  const chunk = (delta) => res.write(`data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", model: served, choices: [{ index: 0, delta }] })}\n\n`);
  if (/weather/.test(prompt) && Array.isArray(body.tools) && body.tools.length) {
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: body.tools[0].function.name, arguments: '{"city":' } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] });
  } else {
    chunk({ reasoning_content: "Routing via OmniRoute." });
    for (const w of ["Hello ", "from ", "OmniRoute!"]) chunk({ content: w });
  }
  res.write(`data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", model: served, choices: [], usage: { prompt_tokens: 120, completion_tokens: 24 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  // ---- test hooks and unauthenticated routes
  if (p === "/_mock/state") return send(res, 200, S);
  if (p === "/_mock/reset") {
    S = createState();
    return send(res, 200, { ok: true });
  }
  if (p === "/api/health") return send(res, 200, { status: "ok", timestamp: iso() });
  if (p === "/api/init") return send(res, 200, { initialized: true });
  if (p === "/api/auth/login" && m === "POST") {
    const body = await readBody(req);
    if (body.password !== PASSWORD) return send(res, 401, { error: "Invalid password" });
    return send(res, 200, { success: true }, { "Set-Cookie": `auth_token=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
  }
  if (p === "/api/auth/logout" && m === "POST") return send(res, 200, { success: true }, { "Set-Cookie": "auth_token=; Max-Age=0; Path=/" });
  if (p === "/api/monitoring/health" && !isManager(req)) return send(res, 200, { status: "healthy", setupComplete: true });

  // ---- inference
  if (p.startsWith("/v1/")) {
    if (bearer(req) !== API_KEY && !hasSession(req)) return send(res, 401, { error: { message: "Invalid API key", type: "invalid_api_key", code: "invalid_api_key" } });
    if (p === "/v1/models" && m === "GET") return send(res, 200, modelList());
    if (p === "/v1/chat/completions" && m === "POST") {
      if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error: { message: "Unsupported Media Type" } });
      return chat(req, res, await readBody(req));
    }
    return send(res, 404, { error: { message: "Not found" } });
  }

  // ---- MCP streamable HTTP (just enough for a reachability check)
  if (p === "/api/mcp/stream") {
    if (!isManager(req) && bearer(req) !== API_KEY) return send(res, 401, { error: "Authentication required" });
    if (!S.settings.mcpEnabled) return send(res, 503, { error: "MCP server is disabled" });
    S.mcpRequests++;
    return send(res, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "omniroute", version: "mock" }, capabilities: { tools: {} } } });
  }

  // ---- management
  if (!p.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  if (!isManager(req)) return send(res, 401, { error: { code: "AUTH_001", message: "Authentication required" } });
  let mm;

  if (p === "/api/monitoring/health" && m === "GET") {
    return send(res, 200, {
      status: "healthy", setupComplete: true, timestamp: iso(),
      catalogCount: 372, configuredCount: S.connections.length, activeCount: S.connections.filter((c) => c.isActive).length, monitoredCount: 3,
      credentialHealth: { healthy: 2, degraded: 0, failing: 1 },
      providerBreakers: [{ provider: "groq", state: "OPEN", failures: 5 }, { provider: "anthropic", state: "CLOSED", failures: 0 }],
      lockouts: S.cooldowns.length ? [{ provider: "groq", model: "llama-4-scout" }] : [],
      sessions: { activeCount: 3, stickyBoundCount: 1 },
    });
  }
  if (p === "/api/monitoring/health" && m === "DELETE") {
    S.breakersReset++;
    return send(res, 200, { success: true, message: "Circuit breakers reset" });
  }
  if (p === "/api/system/version") return send(res, 200, { current: "3.8.52", latest: "3.8.53", updateAvailable: true, channel: "stable" });

  if (p === "/api/combos" && m === "GET") return send(res, 200, { combos: S.combos, total: S.combos.length });
  if (p === "/api/combos" && m === "POST") {
    const body = await readBody(req);
    if (!body.name || !/^[a-zA-Z0-9_./-]+$/.test(body.name)) return send(res, 400, { error: { message: "Invalid request", details: [{ field: "name", message: "Invalid combo name" }] } });
    if (S.combos.some((c) => c.name === body.name)) return send(res, 400, { error: "Combo name already exists" });
    const combo = {
      id: crypto.randomUUID(), name: body.name, strategy: body.strategy || "priority", isActive: true, isHidden: false, sortOrder: S.combos.length, config: body.config || {},
      models: (body.models || []).map((x) => (typeof x === "string" ? { kind: "model", model: x } : x)), createdAt: iso(), updatedAt: iso(),
    };
    S.combos.push(combo);
    return send(res, 201, combo);
  }
  if ((mm = p.match(/^\/api\/combos\/([^/]+)$/))) {
    const c = S.combos.find((x) => x.id === mm[1]);
    if (!c) return send(res, 404, { error: { code: "COMBO_007", message: "Combo not found" } });
    if (m === "GET") return send(res, 200, c);
    if (m === "PUT" || m === "PATCH") {
      Object.assign(c, await readBody(req), { updatedAt: iso() });
      return send(res, 200, c);
    }
    if (m === "DELETE") {
      S.combos = S.combos.filter((x) => x !== c);
      return send(res, 200, { success: true });
    }
  }

  if (p === "/api/providers" && m === "GET") return send(res, 200, { connections: S.connections, total: S.connections.length });
  if ((mm = p.match(/^\/api\/providers\/([^/]+)\/test$/)) && m === "POST") {
    const c = S.connections.find((x) => x.id === mm[1]);
    if (!c) return send(res, 404, { error: "Connection not found" });
    const valid = c.testStatus !== "error";
    c.lastTested = iso();
    return send(res, 200, { valid, error: valid ? null : c.lastError, warning: null, refreshed: false, diagnosis: null, latencyMs: valid ? 210 : 95, statusCode: valid ? 200 : 401, runtime: null, testedAt: c.lastTested });
  }
  if ((mm = p.match(/^\/api\/providers\/([^/]+)$/)) && (m === "PUT" || m === "PATCH")) {
    const c = S.connections.find((x) => x.id === mm[1]);
    if (!c) return send(res, 404, { error: "Connection not found" });
    Object.assign(c, await readBody(req));
    return send(res, 200, { connection: c });
  }

  if (p === "/api/keys" && m === "GET") return send(res, 200, { keys: S.keys, total: S.keys.length, allowKeyReveal: false });
  if (p === "/api/keys" && m === "POST") {
    const body = await readBody(req);
    if (!body.name) return send(res, 400, { error: { message: "Invalid request", details: [{ field: "name", message: "Required" }] } });
    const full = `sk-omni-${crypto.randomBytes(8).toString("hex")}`;
    const k = { id: crypto.randomUUID(), name: body.name, key: `${full.slice(0, 8)}****${full.slice(-4)}`, isActive: true, createdAt: iso(), scopes: body.scopes || [], modelAccessMode: "all" };
    S.keys.push(k);
    return send(res, 201, { key: full, name: k.name, id: k.id, machineId: null, modelAccessMode: "all" });
  }
  if ((mm = p.match(/^\/api\/keys\/([^/]+)$/)) && m === "DELETE") {
    S.keys = S.keys.filter((k) => k.id !== mm[1]);
    return send(res, 200, { message: "Key deleted successfully" });
  }

  if (p === "/api/usage/analytics") {
    return send(res, 200, {
      summary: { totalRequests: 258, successRatePct: 97.3, avgLatencyMs: 1010, totalCost: 1.8432, fallbackCount: 9, promptTokens: 410000, completionTokens: 52000 },
      byProvider: [
        { provider: "anthropic", requests: 182, cost: 1.41, avgLatencyMs: 980, successRatePct: 99 },
        { provider: "openai", requests: 64, cost: 0.4302, avgLatencyMs: 1220, successRatePct: 97 },
        { provider: "groq", requests: 12, cost: 0.003, avgLatencyMs: 310, successRatePct: 75 },
      ],
      byModel: [
        { model: "anthropic/claude-sonnet-5-5", provider: "anthropic", requests: 182, promptTokens: 300000, completionTokens: 40000, totalTokens: 340000, avgLatencyMs: 980, successRatePct: 99, lastUsed: iso(6e4), cost: 1.41 },
        { model: "openai/gpt-5.4", provider: "openai", requests: 64, promptTokens: 100000, completionTokens: 11000, totalTokens: 111000, avgLatencyMs: 1220, successRatePct: 97, lastUsed: iso(36e5), cost: 0.4302 },
        { model: "groq/llama-4-scout", provider: "groq", requests: 12, promptTokens: 10000, completionTokens: 1000, totalTokens: 11000, avgLatencyMs: 310, successRatePct: 75, lastUsed: iso(72e5), cost: 0.003 },
      ],
      dailyTrend: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10), requests: 8 + ((i * 7) % 23), cost: +(0.05 + ((i * 13) % 17) / 100).toFixed(4) })),
    });
  }
  if (p === "/api/analytics/auto-routing") return send(res, 200, { totalRequests: 140, variantBreakdown: { default: 60, coding: 70, fast: 10 }, topProviders: [{ provider: "anthropic", count: 110 }, { provider: "openai", count: 30 }] });
  if (p === "/api/usage/call-logs") {
    let rows = S.callLogs;
    const cid = url.searchParams.get("correlationId");
    if (cid) rows = rows.filter((r) => r.correlationId === cid);
    return send(res, 200, rows.slice(0, Number(url.searchParams.get("limit")) || 50));
  }
  if (p === "/api/cache/stats" && m === "GET") return send(res, 200, S.cache);
  if (p === "/api/cache/stats" && m === "DELETE") {
    S.cache = { size: 0, maxSize: 500, hits: 0, misses: 0, hitRate: 0 };
    return send(res, 200, { success: true, message: "Cache cleared" });
  }
  if (p === "/api/resilience/reset" && m === "POST") {
    S.breakersReset++;
    S.cooldowns = [];
    return send(res, 200, { ok: true, resetCount: 1, message: "Reset 1 breaker" });
  }
  if (p === "/api/resilience/model-cooldowns") {
    if (m === "DELETE") {
      S.cooldowns = [];
      return send(res, 200, { ok: true, clearedAll: true });
    }
    return send(res, 200, { items: S.cooldowns });
  }
  if (p === "/api/settings/compression") {
    if (m === "PUT") Object.assign(S.compression, await readBody(req));
    return send(res, 200, S.compression);
  }
  if (p === "/api/settings") {
    if (m === "PATCH") Object.assign(S.settings, await readBody(req));
    // Quota cutoff/warn thresholds live under resilience.quotaPreflight.
    return send(res, 200, {
      ...S.settings, settingsRevision: 7, hasPassword: true,
      resilience: { quotaPreflight: { enabled: false, defaultThresholdPercent: 5, warnThresholdPercent: 25, providerWindowDefaults: {} } },
    });
  }
  if (p === "/api/usage/provider-limits") {
    return send(res, 200, { caches: S.providerLimits, intervalMinutes: 30, lastAutoSyncAt: iso(3e5) });
  }
  if (p === "/api/mcp/status") {
    return send(res, 200, {
      status: S.settings.mcpEnabled ? "online" : "offline", online: S.settings.mcpEnabled, enabled: S.settings.mcpEnabled, transport: S.settings.mcpTransport, scopesEnforced: false,
      activity: { totalCalls24h: 37, successRate: 0.97, avgDurationMs: 140, topTools: [{ tool: "omniroute_list_combos", count: 12 }], lastCallAt: iso(3e5), lastCallTool: "omniroute_get_health" },
    });
  }
  if (p === "/api/mcp/tools") return send(res, 200, { total: 3, mappedTotal: 3, tools: [{ name: "omniroute_get_health", description: "Gateway health", scopes: ["read"], phase: 1, auditLevel: "low", sourceEndpoints: [] }, { name: "omniroute_list_combos", description: "List combos", scopes: ["read"], phase: 1, auditLevel: "low", sourceEndpoints: [] }, { name: "omniroute_switch_combo", description: "Switch the active combo", scopes: ["write"], phase: 2, auditLevel: "high", sourceEndpoints: [] }] });
  if (p === "/api/shutdown" && m === "POST") {
    S.shutdownCalls++;
    return send(res, 200, { success: true, message: "Shutting down..." });
  }
  if (p === "/api/restart" && m === "POST") {
    S.restartCalls++;
    return send(res, 200, { status: "restarting" });
  }
  return send(res, 404, { error: "Not found" });
}

function start(port = 0) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

module.exports = { start, API_KEY, ADMIN_KEY, PASSWORD };

if (require.main === module) {
  const port = Number(process.argv[2]) || 20129;
  start(port).then(() => console.log(`mock OmniRoute on http://127.0.0.1:${port}  (API key ${API_KEY}, admin key ${ADMIN_KEY}, password "${PASSWORD}")`));
}
