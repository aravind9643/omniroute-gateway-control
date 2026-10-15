// Drives media/dashboard.js in jsdom with a fake extension host: rendering, escaping and the message protocol.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { dashboardState } = require("./fixtures");

const script = fs.readFileSync(path.join(__dirname, "..", "media", "dashboard.js"), "utf8");

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => {} });
  window.eval(script);
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  return {
    window, sent, $, $$,
    deliver: (data) => window.dispatchEvent(new window.MessageEvent("message", { data })),
    state: (s) => window.dispatchEvent(new window.MessageEvent("message", { data: { type: "state", state: s } })),
    click: (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    change: (el) => el.dispatchEvent(new window.Event("change", { bubbles: true })),
    input: (el, v) => {
      el.value = v;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    key: (el, key) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })),
    tab: (id) => window.document.querySelector(`[data-tab="${id}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
  };
}

async function run(tests) {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n    ${err && err.stack ? err.stack.split("\n").slice(0, 14).join("\n    ") : err}`);
    }
  }
  console.log(failed ? `${failed} test(s) failed` : `all ${tests.length} tests passed`);
  return failed;
}

const t = boot();
run([
  ["announces ready, then renders the overview with KPIs, attention and routing", () => {
    assert.deepStrictEqual(t.sent[0], { type: "ready" });
    t.state(dashboardState());
    assert.ok(t.$("#panel-overview").classList.contains("active"));
    const kpi = Object.fromEntries(t.$$("#panel-overview .kpi").map((k) => [k.querySelector(".kpi-label").textContent, k.querySelector(".kpi-value").textContent]));
    assert.deepStrictEqual(kpi, { "Copilot models": "5", Providers: "3/4", "Requests · 30d": "258", "Spend · 30d": "$1.84" });
    const attention = t.$("#panel-overview .banners").textContent;
    assert.ok(attention.includes("Circuit breaker open for groq"), attention);
    assert.ok(attention.includes("cooling down"), attention);
    assert.ok(attention.includes("OmniRoute 3.8.53 is available"), attention);
    assert.ok(t.$("#panel-overview").textContent.includes("auto/coding"));
    assert.ok(t.$("#panel-overview").textContent.includes("All providers in combo exhausted"));
    assert.strictEqual(t.$("#count-models").textContent, "5");
  }],

  ["hostile model and provider names are escaped everywhere", () => {
    for (const tab of ["models", "combos", "providers", "usage", "settings", "overview"]) t.tab(tab);
    assert.strictEqual(t.window.pwned, undefined);
    assert.strictEqual(t.$$("img").length + t.$$("script").length, 0);
    assert.ok(t.$("#panel-models").innerHTML.includes("&lt;img"));
  }],

  ["attention actions post commands", () => {
    t.tab("overview");
    t.click(t.$('#panel-overview [data-action="resetBreakers"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "resetBreakers" });
    t.click(t.$('#panel-overview [data-action="clearCooldowns"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "clearCooldowns" });
  }],

  ["models: filters, auto/combos follow their switch, catalog models are ticked individually", () => {
    t.tab("models");
    assert.strictEqual(t.$("#pageTitle").textContent, "Models");
    assert.strictEqual(t.$$("#panel-models tbody tr").length, 8, "embedding model is hidden");
    t.click(t.$('[data-kind="auto"]'));
    assert.strictEqual(t.$$("#panel-models tbody tr").length, 3);
    assert.ok(t.$('[data-action="pick"][data-id="auto/coding"]').disabled, "auto models follow the switch");
    t.click(t.$('[data-kind="all"]'));
    t.input(t.$("#mq"), "gpt");
    assert.strictEqual(t.$$("#panel-models tbody tr").length, 1);
    const cb = t.$('[data-action="pick"][data-id="openai/gpt-5.4"]');
    cb.checked = true;
    t.change(cb);
    assert.deepStrictEqual(t.sent.at(-1), { type: "togglePicked", ids: ["openai/gpt-5.4"], on: true });
    t.input(t.$("#mq"), "");
    const sw = t.$('[data-setting="copilot.includeAutoModels"]');
    sw.checked = false;
    t.change(sw);
    assert.deepStrictEqual(t.sent.at(-1), { type: "setSetting", key: "copilot.includeAutoModels", value: false });
    t.change(Object.assign(t.$("#mprov"), { value: "groq" }));
    assert.strictEqual(t.$$("#panel-models tbody tr").length, 1);
    t.click(t.$('[data-action="pick-shown"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "togglePicked", ids: ["groq/llama-4-scout"], on: true });
    t.change(Object.assign(t.$("#mprov"), { value: "" }));
  }],

  ["combos: list, toggle, delete and the create form with ordering", () => {
    t.tab("combos");
    const cards = t.$$("#panel-combos .card.route");
    assert.strictEqual(cards.length, 2);
    assert.ok(cards[0].textContent.includes("In Copilot") && cards[1].textContent.includes("nested combo"));
    const sw = t.$('[data-action="combo-active"][data-id="c2"]');
    sw.checked = true;
    t.change(sw);
    assert.deepStrictEqual(t.sent.at(-1), { type: "toggleCombo", id: "c2", active: true });
    t.click(t.$('[data-action="combo-delete"][data-id="c1"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "deleteCombo", id: "c1", name: "coding" });

    t.click(t.$('#pageActions [data-action="new-combo"]'));
    assert.ok(t.$(".combo-form"));
    assert.ok(t.$('[data-action="draft-save"]').disabled);
    t.input(t.$("#c-name"), "smart");
    for (const id of ["openai/gpt-5.4", "anthropic/claude-sonnet-5-5"]) {
      t.input(t.$("#c-add"), id);
      t.key(t.$("#c-add"), "Enter");
    }
    t.click(t.$('[data-action="draft-move"][data-index="1"][data-dir="-1"]'));
    t.change(Object.assign(t.$("#c-strategy"), { value: "latency" }));
    // A state push while the form is open must not wipe it.
    t.state(dashboardState());
    assert.strictEqual(t.$("#c-name").value, "smart");
    t.click(t.$('[data-action="draft-save"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "createCombo", name: "smart", strategy: "latency", models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.4"] });
    t.deliver({ type: "result", ok: true, text: 'Created combo "smart"' });
    assert.strictEqual(t.$(".combo-form"), null, "form closes on success");
    assert.ok(t.$("#toast").textContent.includes("Created combo"));
  }],

  ["providers: status pills, test and enable", () => {
    t.tab("providers");
    const text = t.$("#panel-providers").textContent;
    assert.ok(text.includes("401 Invalid API key") && text.includes("Disabled") && text.includes("372 providers available"));
    t.click(t.$('[data-action="conn-test"][data-id="p3"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "testConnection", id: "p3" });
    const sw = t.$('[data-action="conn-active"][data-id="p4"]');
    sw.checked = true;
    t.change(sw);
    assert.deepStrictEqual(t.sent.at(-1), { type: "toggleConnection", id: "p4", active: true });
  }],

  ["providers: quota bars show usable headroom, not the raw percentage", () => {
    t.tab("providers");
    const rows = t.$$("#panel-providers .quota-row");
    assert.ok(rows.length >= 4, `expected quota rows, got ${rows.length}`);
    // cutoff 5% => 69% raw is (69-5)/95 = 67% usable; 6% raw is ~1%.
    const session = rows.find((r) => r.textContent.includes("session (5h)"));
    assert.ok(session.textContent.includes("67%"), session.textContent);
    assert.ok(session.querySelector(".bar.ok"), "healthy window is green");
    const weekly = rows.find((r) => r.textContent.includes("weekly (7d)"));
    assert.ok(weekly.querySelector(".bar.warn") || weekly.querySelector(".bar.err"), "near-exhausted window is flagged");
    // The raw upstream value stays available in the tooltip.
    assert.ok(weekly.getAttribute("title").includes("6% raw upstream"), weekly.getAttribute("title"));
    // An unlimited balance must not render as exhausted.
    const bal = rows.find((r) => r.textContent.includes("Balance (USD)"));
    assert.ok(bal.querySelector(".bar.unlimited") && !bal.querySelector(".bar.err"), bal.innerHTML);
    // A provider that cannot report quota explains itself instead of showing empty bars.
    assert.ok(t.$("#panel-providers").textContent.includes("Quota reporting is not supported"));
  }],

  ["usage: tables, auto-routing and recent calls", () => {
    t.tab("usage");
    const text = t.$("#panel-usage").textContent;
    assert.ok(text.includes("$1.41") && text.includes("auto/coding") && text.includes("auto/coding → anthropic/claude-sonnet-5-5"));
    assert.strictEqual(t.$$("#panel-usage .spark-bar").length, 14);
  }],

  ["settings: extension settings, gateway controls and server actions", () => {
    t.tab("settings");
    t.change(Object.assign(t.$('[data-setting="chat.compression"]'), { value: "rtk" }));
    assert.deepStrictEqual(t.sent.at(-1), { type: "setSetting", key: "chat.compression", value: "rtk" });
    t.change(Object.assign(t.$('[data-action="compression"]'), { value: "off" }));
    assert.deepStrictEqual(t.sent.at(-1), { type: "setCompression", enabled: false });
    const mcp = t.$('[data-action="server-setting"][data-key="mcpEnabled"]');
    mcp.checked = false;
    t.change(mcp);
    assert.deepStrictEqual(t.sent.at(-1), { type: "setServerSetting", key: "mcpEnabled", value: false });
    t.click(t.$('#panel-settings [data-action="stopServer"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "stopServer" });
  }],

  ["without management access, pages degrade to read-only with sign-in prompts", () => {
    const s = dashboardState({ snap: { canManage: false, usage: undefined, connections: [], health: undefined } });
    t.state(s);
    t.tab("providers");
    assert.ok(t.$("#panel-providers").textContent.includes("Sign in to see provider connections"));
    t.tab("overview");
    t.click(t.$('#panel-overview [data-action="signIn"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "signIn" });
    t.tab("settings");
    assert.ok(!t.$("#panel-settings").textContent.includes("Circuit breakers"), "gateway section needs management");
  }],

  ["offline and needs-key screens offer the right next step", () => {
    t.state(dashboardState({ snap: { state: "offline" } }));
    t.tab("models");
    t.click(t.$('#panel-models [data-action="startServer"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "startServer" });
    t.state(dashboardState({ snap: { state: "needsKey", error: "HTTP 401: Invalid API key" } }));
    assert.ok(t.$("#panel-models").textContent.includes("needs an API key"));
    t.click(t.$('#panel-models [data-action="setApiKey"]'));
    assert.deepStrictEqual(t.sent.at(-1), { type: "setApiKey" });
  }],
]).then((failed) => process.exit(failed ? 1 : 0));
