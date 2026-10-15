// Runs inside a real VS Code extension host (see .vscode-test.mjs) against test/mockServer.js.
const assert = require("assert");
const vscode = require("vscode");
const mock = require("../mockServer");

const EXT_ID = "AravindMerugu.omniroute-gateway-control";

async function waitFor(fn, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

suite("Gateway Control for OmniRoute", function () {
  let server;
  let base;
  let api;
  const cfg = () => vscode.workspace.getConfiguration("omniroute");
  const G = vscode.ConfigurationTarget.Global;

  suiteSetup(async () => {
    server = await mock.start(0);
    base = `http://127.0.0.1:${server.address().port}`;
    await cfg().update("baseUrl", base, G);
    api = await vscode.extensions.getExtension(EXT_ID).activate();
  });

  suiteTeardown(async () => {
    for (const k of ["baseUrl", "copilot.models", "chat.compression"]) await cfg().update(k, undefined, G);
    await api?.test?.setApiKey(undefined);
    await api?.test?.setManagementKey(undefined);
    server?.close();
  });

  test("activates, registers every command, and only exposes test hooks in test mode", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext.isActive);
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = ext.packageJSON.contributes.commands.map((c) => c.command).filter((c) => !all.has(c));
    assert.deepStrictEqual(missing, []);
    assert.ok(api.test, "test hooks exist in ExtensionMode.Test");
    const title = ext.packageJSON.contributes.commands.find((c) => c.command === "omniroute.openDashboard").title;
    assert.ok(!title.startsWith("%"), `manifest strings are localized (got ${title})`);
  });

  test("without a key the gateway is reported as needing one and nothing reaches Copilot", async () => {
    await api.test.store.refresh();
    assert.strictEqual(api.test.store.snapshot.state, "needsKey");
    assert.deepStrictEqual(await vscode.lm.selectChatModels({ vendor: "omniroute" }), []);
  });

  test("auto/* models and combos are served through vscode.lm, with OmniRoute headers and routing info", async () => {
    await api.test.setApiKey(mock.API_KEY);
    await api.test.setManagementKey(mock.ADMIN_KEY);
    await cfg().update("chat.compression", "rtk", G);
    await cfg().update("copilot.models", ["groq/llama-4-scout"], G);
    await api.test.store.refresh();
    const models = await waitFor(async () => {
      const list = await vscode.lm.selectChatModels({ vendor: "omniroute" });
      return list.length >= 7 ? list : undefined;
    }, "OmniRoute models in vscode.lm");
    assert.deepStrictEqual(models.map((m) => m.id).sort(), ["auto", "auto/cheap", "auto/coding", "auto/fast", "auto/smart", "coding", "groq/llama-4-scout"]);
    const coding = models.find((m) => m.id === "auto/coding");
    assert.ok(coding.maxInputTokens > 0 && coding.maxInputTokens < 128000);

    const response = await coding.sendRequest([vscode.LanguageModelChatMessage.User("hello from the integration test")], {}, new vscode.CancellationTokenSource().token);
    let text = "";
    for await (const chunk of response.text) text += chunk;
    assert.ok(text.includes("Hello from OmniRoute!"), text);
    assert.ok(text.includes("Routing via OmniRoute."), "reasoning is shown");

    const last = (await (await fetch(`${base}/_mock/state`)).json()).lastChat;
    assert.strictEqual(last.body.model, "auto/coding");
    assert.strictEqual(last.headers["x-omniroute-compression"], "rtk");
    assert.ok(last.headers["x-omniroute-session-id"].startsWith("vscode-"));

    // Refreshes keep firing (the poll timer) while enrichment is pending; the record must survive them.
    const racing = setInterval(() => void api.test.store.refresh(), 150);
    // The call log lookup fills in the provider for the status bar / recent requests.
    const rec = await waitFor(
      () => api.test.store.snapshot.routing.find((r) => r.requested === "auto/coding" && r.provider),
      "routing record enriched from call logs"
    ).finally(() => clearInterval(racing));
    assert.strictEqual(rec.served, "anthropic/claude-sonnet-5-5");
    assert.strictEqual(rec.comboName, "auto/coding");
  });

  test("tool calls stream back to the caller", async () => {
    const [model] = await vscode.lm.selectChatModels({ vendor: "omniroute", id: "coding" });
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User("what's the weather?")],
      { tools: [{ name: "get_weather", description: "Weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }] },
      new vscode.CancellationTokenSource().token
    );
    const calls = [];
    for await (const part of response.stream) if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part);
    assert.deepStrictEqual(calls.map((c) => [c.name, c.input]), [["get_weather", { city: "Paris" }]]);
  });

  test("upstream failures surface as readable errors", async () => {
    const [model] = await vscode.lm.selectChatModels({ vendor: "omniroute", id: "auto" });
    await assert.rejects(
      async () => {
        const r = await model.sendRequest([vscode.LanguageModelChatMessage.User("please fail")], {}, new vscode.CancellationTokenSource().token);
        for await (const _ of r.text) {
          // drain
        }
      },
      (err) => /All providers in combo exhausted/.test(String(err?.message ?? err))
    );
  });

  test("management data loads and management commands reach the gateway", async () => {
    const s = api.test.store.snapshot;
    assert.strictEqual(s.canManage, true);
    assert.strictEqual(s.combos.length, 2);
    assert.strictEqual(s.connections.length, 4);
    assert.strictEqual(s.health.catalogCount, 372);
    // Provider quota is cached by the gateway and read on every refresh.
    assert.strictEqual(s.quota.cutoffPercent, 5, "cutoff comes from the gateway, not our default");
    assert.strictEqual(s.quota.byConnection.p1.windows.length, 2);
    await vscode.commands.executeCommand("omniroute.resetBreakers");
    await vscode.commands.executeCommand("omniroute.clearCooldowns");
    const st = await (await fetch(`${base}/_mock/state`)).json();
    assert.strictEqual(st.breakersReset, 1);
    assert.strictEqual(st.cooldowns.length, 0);
  });

  test("the dashboard opens as an editor tab and the sidebar view can be focused", async () => {
    await vscode.commands.executeCommand("omniroute.openDashboard");
    const tab = await waitFor(
      () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === "OmniRoute"),
      "the dashboard tab"
    );
    assert.ok(tab);
    await vscode.commands.executeCommand("omniroute.explorer.focus");
  });
});
