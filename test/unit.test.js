// Unit tests for the vscode-free modules (compiled to out/) against test/mockServer.js. Run: npm test
const assert = require("assert");
const path = require("path");
const mock = require("./mockServer");
const out = (m) => require(path.join(__dirname, "..", "out", m));
const { OmniClient, ApiError, errorMessage, normalizeBaseUrl, toModel, toUsage, isChatModel, effectiveRemaining, worstWindow } = out("client.js");
const { readChatStream, parseRoutingHeaders, describeRouting, ThinkTagSplitter, requestHeaders, formatUsd } = out("stream.js");
const { launchCommand } = out("launch.js");

async function run(tests) {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n    ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n    ") : err}`);
    }
  }
  console.log(failed ? `${failed} test(s) failed` : `all ${tests.length} tests passed`);
  return failed;
}

const creds = (c = {}) => ({ apiKey: async () => c.api, managementHeaders: async () => ({ ...(c.cookie ? { Cookie: `auth_token=${c.cookie}` } : {}), ...(c.mgmt ? { Authorization: `Bearer ${c.mgmt}` } : {}) }) });

(async () => {
  const server = await mock.start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const make = (c, url = base) => new OmniClient({ baseUrl: () => url, timeoutMs: () => 5000, credentials: creds(c) });
  const state = async () => (await fetch(`${base}/_mock/state`)).json();
  const reset = () => fetch(`${base}/_mock/reset`);
  const admin = make({ api: mock.API_KEY, mgmt: mock.ADMIN_KEY });

  const failed = await run([
    ["base URL normalization strips /v1, /api and slashes", () => {
      assert.strictEqual(normalizeBaseUrl("http://h:20128/v1/"), "http://h:20128");
      assert.strictEqual(normalizeBaseUrl(" http://h/api "), "http://h");
      assert.strictEqual(make({}, "http://x:1/v1").openAiBaseUrl, "http://x:1/v1");
    }],

    ["error envelopes: string, {message}, validation details, OpenAI shape, plain text", () => {
      assert.strictEqual(errorMessage(401, '{"error":"Invalid password"}'), "HTTP 401: Invalid password");
      assert.strictEqual(errorMessage(404, '{"error":{"code":"COMBO_007","message":"Combo not found"}}'), "HTTP 404: Combo not found");
      assert.strictEqual(errorMessage(400, '{"error":{"message":"Invalid request","details":[{"field":"name","message":"Required"}]}}'), "HTTP 400: Invalid request: name Required");
      assert.strictEqual(errorMessage(502, "<html>Bad gateway</html>"), "HTTP 502: <html>Bad gateway</html>");
    }],

    ["ping needs no auth; unreachable server is false", async () => {
      assert.strictEqual(await make({}).ping(), true);
      assert.strictEqual(await make({}, "http://127.0.0.1:9").ping(500), false);
    }],

    ["models: auth required; auto/*, combos and catalog are told apart", async () => {
      await assert.rejects(make({}).listModels(), (e) => e instanceof ApiError && e.isAuth);
      const models = await make({ api: mock.API_KEY }).listModels();
      const byId = Object.fromEntries(models.map((m) => [m.id, m]));
      assert.strictEqual(byId["auto/coding"].kind, "auto");
      assert.strictEqual(byId["coding"].kind, "combo");
      assert.strictEqual(byId["cheap-chat"], undefined, "inactive combos are not listed");
      const sonnet = byId["anthropic/claude-sonnet-5-5"];
      assert.deepStrictEqual([sonnet.kind, sonnet.ownedBy, sonnet.contextLength, sonnet.toolCalling, sonnet.vision], ["model", "anthropic", 1000000, true, true]);
      assert.strictEqual(isChatModel(byId["openai/text-embedding-3-small"]), false);
      assert.strictEqual(toModel({ id: "x", input_modalities: ["text", "image"] }).vision, true);
    }],

    ["login returns the session cookie, which grants management access", async () => {
      await assert.rejects(make({}).login("wrong"), /Invalid password/);
      const cookie = await make({}).login(mock.PASSWORD);
      assert.strictEqual(cookie, "mock-session-token");
      assert.strictEqual(await make({ api: mock.API_KEY }).canManage(), false, "an inference key is not a management credential");
      assert.strictEqual(await make({ cookie }).canManage(), true);
      assert.strictEqual(await admin.canManage(), true);
      const h = await make({ cookie }).health();
      assert.strictEqual(h.catalogCount, 372);
      assert.deepStrictEqual(h.openBreakers, [{ provider: "groq", state: "OPEN" }]);
    }],

    ["combos: list, create (ordered steps), toggle, delete", async () => {
      await reset();
      const before = await admin.combos();
      assert.deepStrictEqual(before.map((c) => [c.name, c.isActive, c.models.length]), [["coding", true, 2], ["cheap-chat", false, 2]]);
      assert.strictEqual(before[1].models[1].kind, "combo-ref");
      const created = await admin.createCombo({ name: "fast", strategy: "latency", models: ["groq/llama-4-scout", "openai/gpt-5.4"] });
      assert.strictEqual(created.name, "fast");
      const stored = (await state()).combos.find((c) => c.name === "fast");
      assert.deepStrictEqual(stored.models, [{ kind: "model", model: "groq/llama-4-scout" }, { kind: "model", model: "openai/gpt-5.4" }]);
      await assert.rejects(admin.createCombo({ name: "fast", strategy: "priority", models: ["x"] }), /already exists/);
      await admin.updateCombo(created.id, { isActive: false });
      assert.strictEqual((await admin.combos()).find((c) => c.name === "fast").isActive, false);
      await admin.deleteCombo(created.id);
      assert.ok(!(await admin.combos()).some((c) => c.name === "fast"));
    }],

    ["connections: test result and enable/disable", async () => {
      const conns = await admin.connections();
      assert.strictEqual(conns.length, 4);
      assert.strictEqual(conns.find((c) => c.id === "p3").lastError, "401 Invalid API key");
      assert.deepStrictEqual(await admin.testConnection("p1"), { valid: true, error: undefined, latencyMs: 210 });
      assert.strictEqual((await admin.testConnection("p3")).valid, false);
      await admin.setConnectionActive("p2", false);
      assert.strictEqual((await state()).connections.find((c) => c.id === "p2").isActive, false);
    }],

    ["API keys: create returns the plaintext key once; list is masked; delete", async () => {
      const { key, id } = await admin.createApiKey("test", ["mcp:connect"]);
      assert.match(key, /^sk-omni-[0-9a-f]{16}$/);
      const listed = (await admin.apiKeys()).find((k) => k.id === id);
      assert.ok(listed.key.includes("****") && !listed.key.includes(key.slice(8, 14)));
      assert.deepStrictEqual(listed.scopes, ["mcp:connect"]);
      await admin.deleteApiKey(id);
      assert.ok(!(await admin.apiKeys()).some((k) => k.id === id));
    }],

    ["usage analytics are normalized and sorted by cost", async () => {
      const u = await admin.usage();
      assert.strictEqual(u.totalRequests, 258);
      assert.strictEqual(u.byModel[0].key, "anthropic/claude-sonnet-5-5");
      assert.strictEqual(u.byProvider.length, 3);
      assert.strictEqual(u.daily.length, 14);
      assert.deepStrictEqual(toUsage({}), { totalRequests: 0, totalCost: 0, successRatePct: undefined, avgLatencyMs: undefined, fallbackCount: undefined, byModel: [], byProvider: [], daily: [] });
      const ar = await admin.autoRouting();
      assert.strictEqual(ar.variants.coding, 70);
    }],

    ["gateway controls: cache, breakers, cooldowns, compression, MCP status", async () => {
      await reset();
      assert.strictEqual((await admin.cacheStats()).size, 42);
      await admin.clearCache();
      assert.strictEqual((await admin.cacheStats()).size, 0);
      assert.strictEqual((await admin.cooldowns()).length, 1);
      await admin.clearCooldowns();
      assert.strictEqual((await admin.cooldowns()).length, 0);
      assert.strictEqual(await admin.resetBreakers(), 1);
      const comp = await admin.setCompression({ enabled: true, defaultMode: "aggressive" });
      assert.deepStrictEqual([comp.enabled, comp.defaultMode], [true, "aggressive"]);
      const mcp = await admin.mcpStatus();
      assert.deepStrictEqual([mcp.enabled, mcp.online, mcp.transport, mcp.calls24h], [true, true, "streamable-http", 37]);
      assert.strictEqual((await admin.mcpTools()).length, 3);
    }],

    ["provider quota: windows normalized, unlimited and message-only entries survive", async () => {
      const q = await admin.providerLimits();
      assert.strictEqual(q.intervalMinutes, 30);
      const p1 = q.byConnection.p1;
      assert.deepStrictEqual(p1.windows.map((w) => w.label), ["session (5h)", "weekly (7d)"]);
      assert.strictEqual(p1.plan, "default_raven");
      const weekly = p1.windows.find((w) => w.label === "weekly (7d)");
      assert.deepStrictEqual([weekly.used, weekly.total, weekly.remainingPercentage, weekly.unlimited], [94, 100, 6, false]);
      // displayName wins over the raw key, and an unlimited balance keeps its flag.
      const balance = q.byConnection.p2.windows.find((w) => w.unlimited);
      assert.deepStrictEqual([balance.label, balance.currency, balance.resetAt], ["Balance (USD)", "USD", null]);
      // quotas:null plus a message is still worth showing.
      assert.deepStrictEqual([q.byConnection.p3.windows.length, q.byConnection.p3.message.slice(0, 5)], [0, "Quota"]);
    }],

    ["quota cutoff: effective headroom reaches 0 exactly where routing stops", async () => {
      // OmniRoute reserves `cutoff`%, so the raw value overstates usable headroom.
      assert.strictEqual(effectiveRemaining(40, 25), 20);
      assert.strictEqual(effectiveRemaining(25, 25), 0);
      assert.strictEqual(effectiveRemaining(10, 25), 0);
      assert.strictEqual(effectiveRemaining(100, 0), 100);
      assert.strictEqual(effectiveRemaining(undefined, 25), undefined);
      // Thresholds come from the gateway, not our defaults.
      const t = await admin.quotaThresholds();
      assert.deepStrictEqual([t.cutoffPercent, t.warnPercent], [5, 25]);
      // Unlimited windows must never be picked as the worst, despite remaining 0.
      const q = await admin.providerLimits();
      assert.strictEqual(worstWindow(q.byConnection.p1, 5).label, "weekly (7d)");
      assert.strictEqual(worstWindow(q.byConnection.p2, 5).isPercentageOnly, true);
      assert.strictEqual(worstWindow(q.byConnection.p3, 5), undefined);
    }],

    ["streaming chat: headers sent, text/reasoning/tool calls parsed, call log found by correlation id", async () => {
      const c = make({ api: mock.API_KEY, mgmt: mock.ADMIN_KEY });
      const cfg = { get: (k, d) => ({ compression: "aggressive", bypassCache: true, disableMemory: false })[k] ?? d };
      const headers = requestHeaders(cfg, "vscode-session", "corr-1");
      assert.strictEqual(headers["X-OmniRoute-Compression"], "aggressive");
      assert.strictEqual(headers["X-OmniRoute-No-Cache"], "true");
      assert.strictEqual(headers["x-omniroute-no-memory"], undefined);
      const res = await c.chat({ model: "auto/coding", messages: [{ role: "user", content: "hi" }], stream: true }, headers, AbortSignal.timeout(5000));
      assert.strictEqual(res.status, 200);
      const routing = parseRoutingHeaders(res.headers);
      assert.match(routing.decision, /strategy=auto/);
      const parts = { text: "", reasoning: "", calls: [] };
      const usage = await readChatStream(res.body, { text: (t) => (parts.text += t), reasoning: (t) => (parts.reasoning += t), toolCall: (...a) => parts.calls.push(a) });
      assert.strictEqual(parts.text, "Hello from OmniRoute!");
      assert.strictEqual(parts.reasoning, "Routing via OmniRoute.");
      assert.deepStrictEqual(usage, { servedModel: "anthropic/claude-sonnet-5-5", promptTokens: 120, completionTokens: 24 });
      const sent = (await state()).lastChat.headers;
      assert.strictEqual(sent["x-omniroute-session-id"], "vscode-session");
      assert.strictEqual(sent["x-correlation-id"], "corr-1");
      const [log] = await c.callLogs({ correlationId: "corr-1" });
      assert.deepStrictEqual([log.provider, log.requestedModel, log.comboName, log.durationMs], ["Anthropic", "auto/coding", "auto/coding", 412]);

      const tools = await c.chat({ model: "openai/gpt-5.4", messages: [{ role: "user", content: "weather?" }], tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }] }, headers, AbortSignal.timeout(5000));
      const calls = [];
      await readChatStream(tools.body, { text() {}, reasoning() {}, toolCall: (id, name, input) => calls.push({ id, name, input }) });
      assert.deepStrictEqual(calls, [{ id: "call_1", name: "get_weather", input: { city: "Paris" } }]);
    }],

    ["routing headers and summaries", () => {
      const r = parseRoutingHeaders({ "x-omniroute-provider": "anthropic", "x-omniroute-model": "claude", "x-omniroute-latency-ms": "812", "x-omniroute-response-cost": "$0.0031", "x-omniroute-fallback-attempts": "1", "x-omniroute-cache": "HIT" });
      assert.deepStrictEqual(r, { provider: "anthropic", model: "claude", latencyMs: 812, costUsd: 0.0031, fallbackAttempts: 1, cache: "HIT" });
      assert.strictEqual(describeRouting(r), "anthropic · claude · 812ms · $0.0031 · 1 fallback · cache hit");
      assert.deepStrictEqual([formatUsd(0), formatUsd(0.5), formatUsd(12.345)], ["$0", "$0.500", "$12.35"]);
    }],

    ["think tags split across chunks", () => {
      const s = new ThinkTagSplitter();
      const segs = [...s.push("a<thi"), ...s.push("nk>plan</th"), ...s.push("ink>b"), ...s.flush()];
      assert.deepStrictEqual(segs, [{ think: false, text: "a" }, { think: true, text: "plan" }, { think: false, text: "b" }]);
    }],

    ["launch commands: npx default, docker binds to localhost only when asked", () => {
      assert.strictEqual(launchCommand("npx", 20128, "", true), "npx -y omniroute serve");
      assert.strictEqual(launchCommand("global", 20128, "", true), "omniroute serve");
      assert.match(launchCommand("docker", 3000, "", true), /-p 127\.0\.0\.1:3000:20128 .*diegosouzapw\/omniroute$/);
      assert.match(launchCommand("docker", 3000, "", false), /-p 3000:20128 /);
      assert.strictEqual(launchCommand("custom", 1, "  pnpm start ", true), "pnpm start");
    }],

    ["shutdown and restart reach the server", async () => {
      await admin.restart();
      await admin.shutdown();
      const s = await state();
      assert.deepStrictEqual([s.restartCalls, s.shutdownCalls], [1, 1]);
    }],
  ]);
  server.close();
  process.exit(failed ? 1 : 0);
})();
