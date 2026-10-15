/* OmniRoute dashboard — bundled by esbuild into media/dashboard.js and loaded under a strict nonce CSP.
   Rules: every dynamic value goes through esc(); no inline event handlers (data-action + delegation). */
import type { DashboardState, DashboardTab, ExtSettings, HostMessage, WebviewMessage } from "../protocol";
import type { RoutingRecord } from "../types";
import type { OmniModel, ProviderLimits, QuotaWindow } from "../types";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void; getState(): any; setState(state: unknown): void };

(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let S: DashboardState | null = null;

  const ui = {
    tab: (saved.tab || "overview") as DashboardTab,
    q: saved.q || "",
    kind: (saved.kind || "all") as "all" | "auto" | "combo" | "model" | "copilot",
    provider: saved.provider || "",
    comboDraft: null as null | { name: string; strategy: string; models: string[]; description: string; adding: string },
  };
  const persist = () => vscode.setState({ tab: ui.tab, q: ui.q, kind: ui.kind, provider: ui.provider });
  const post = (m: WebviewMessage) => vscode.postMessage(m);

  const STRATEGIES = ["priority", "weighted", "round-robin", "fill-first", "p2c", "random", "latency", "sticky", "cost-optimized", "fusion", "quota-share", "context-relay"];
  /** What each zero-config auto/* variant optimizes for (OmniRoute README). */
  const AUTO_HELP: Record<string, string> = {
    auto: "Best available model for each request",
    coding: "Strongest coding models first",
    fast: "Lowest latency",
    cheap: "Lowest cost",
    subscription: "Prefer subscription accounts (no per-token cost)",
    thrifty: "Free and cheap tiers first",
    offline: "Local models only",
    smart: "Highest quality",
    lkgp: "Last known good provider",
    chaos: "Random — for resilience testing",
  };
  const autoHelp = (id: string) => AUTO_HELP[id === "auto" ? "auto" : id.replace(/^auto\//, "").split(":")[0]] || "Auto-routing";
  const COMPRESSION = ["off", "lite", "standard", "aggressive", "ultra", "rtk", "stacked"];
  const TABS: { id: DashboardTab; label: string; icon: string; desc: string }[] = [
    { id: "overview", label: "Overview", icon: "home", desc: "Gateway health, spend and how your Copilot requests are routed." },
    { id: "models", label: "Models", icon: "symbol-class", desc: "Choose what OmniRoute offers in the Copilot Chat model picker." },
    { id: "combos", label: "Combos", icon: "git-merge", desc: "Named fallback chains. Each combo is usable as a model by any client." },
    { id: "providers", label: "Providers", icon: "plug", desc: "Upstream accounts OmniRoute routes to, with their health." },
    { id: "usage", label: "Usage", icon: "graph", desc: "Requests, cost and latency across everything that uses this gateway." },
    { id: "settings", label: "Settings", icon: "settings-gear", desc: "Connection, local server, Copilot behaviour and gateway controls." },
  ];

  // ------------------------------------------------------------ helpers

  function esc(s: unknown) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
  }
  const icon = (n: string, cls = "") => `<i class="codicon codicon-${n} ${cls}"></i>`;
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const usd = (v: number) => (v === 0 ? "$0" : `$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`);
  const kTok = (n?: number) => (!n ? "—" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const pill = (kind: string, text: string, title = "") => `<span class="pill ${kind}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  /** Mirrors OmniRoute's effectiveRemainingPercent: the cutoff reserve reads as 0% left. */
  function effRemaining(raw: number | undefined, cutoff: number) {
    if (raw === undefined || !Number.isFinite(raw)) return undefined;
    const r = Math.max(0, Math.min(100, raw));
    const c = Math.max(0, Math.min(99, cutoff));
    return r <= c ? 0 : ((r - c) / (100 - c)) * 100;
  }
  /** "in 3h 20m" for a reset timestamp. */
  function resetIn(iso?: string | null) {
    if (!iso) return "";
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return "due";
    const m = Math.round(ms / 60000);
    return m < 60 ? `in ${m}m` : m < 1440 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : `in ${Math.round(m / 1440)}d`;
  }
  /** Counts for a window, e.g. "31 / 100" or "$4.20 left". */
  function windowCounts(w: QuotaWindow) {
    if (w.unlimited) return "unlimited";
    if (w.currency) return w.remaining !== undefined ? `${w.remaining.toFixed(2)} ${w.currency} left` : "";
    if (w.isPercentageOnly || w.total === undefined || w.used === undefined) return "";
    return `${w.used.toLocaleString()} / ${w.total.toLocaleString()}`;
  }
  const ago = (ts?: number | string | null) => {
    if (!ts) return "";
    const ms = Date.now() - (typeof ts === "number" ? ts : Date.parse(ts));
    const m = Math.round(ms / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  /** "2026-10-14" → "Oct 14" in the viewer's locale; anything else is shown as-is. */
  const day = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d;
  function monogram(name: string, size = "") {
    const words = String(name || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
    const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="mono-av ${size} c${h % 6}" aria-hidden="true">${esc(letters)}</span>`;
  }
  const isChat = (m: OmniModel) => !m.type || !/^(embedding|image|rerank|audio|moderation|video|music|tts|stt|ocr)$/.test(m.type);

  let toastTimer: any;
  function toast(text: string, ok = true) {
    const t = $("#toast");
    t.className = `toast ${ok ? "ok" : "err"}`;
    t.innerHTML = `${icon(ok ? "pass-filled" : "error")}<span>${esc(text)}</span>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
  }

  // -------------------------------------------------------------- shell

  const tabButton = (t: (typeof TABS)[number]) =>
    `<button class="tab" role="tab" data-action="tab" data-tab="${t.id}" title="${t.label}">${icon(t.icon)}<span class="tab-label">${t.label}</span><span class="count hidden" id="count-${t.id}"></span></button>`;

  $("#app").innerHTML = `
    <nav class="rail" aria-label="Sections">
      <div class="brand">
        <span class="brand-mark">${icon("radio-tower")}<span class="dot" id="brandDot"></span></span>
        <span class="brand-text"><strong>OmniRoute</strong><span>AI gateway</span></span>
      </div>
      <div class="nav-label">Gateway</div>
      <div class="nav" role="tablist" aria-orientation="vertical">${TABS.filter((t) => t.id !== "settings").map(tabButton).join("")}</div>
      <div class="rail-spacer"></div>
      <div class="conn-card" id="stats"></div>
      <div class="rail-foot">
        ${tabButton(TABS.find((t) => t.id === "settings")!)}
        <button class="rail-link" data-action="openWeb" title="Open OmniRoute's own web dashboard">${icon("link-external")}<span class="tab-label">Web dashboard</span></button>
      </div>
    </nav>
    <div class="main">
      <header class="page-head">
        <div class="page-title"><h1 id="pageTitle"></h1><p id="pageDesc"></p></div>
        <div class="page-actions" id="pageActions"></div>
      </header>
      <main class="app-body">
        ${TABS.map((t) => `<section class="panel" id="panel-${t.id}"></section>`).join("")}
      </main>
    </div>
    <div id="toast" class="toast hidden" role="status"></div>`;

  // ------------------------------------------------------------- render

  function render() {
    renderChrome();
    if (!S) {
      $(`#panel-${ui.tab}`).innerHTML = `<div class="empty">${icon("loading", "spin")}Connecting…</div>`;
      return;
    }
    if (S.snap.state !== "online") {
      // Every page shows the same connection screen until /v1 works.
      for (const t of TABS) if (t.id !== "settings") $(`#panel-${t.id}`).innerHTML = connectScreen();
      renderSettings();
      return;
    }
    renderOverview();
    renderModels();
    renderCombos();
    renderProviders();
    renderUsage();
    renderSettings();
  }

  /** One word for the gateway's state, shared by the rail and the Overview. */
  function status() {
    const s = S!.snap;
    if (s.state === "offline") return { level: "err", label: "Offline" };
    if (s.state === "needsKey") return { level: "warn", label: "Needs API key" };
    return attention().some((a) => a.sev === "warn") ? { level: "warn", label: "Degraded" } : { level: "ok", label: "Healthy" };
  }

  function renderChrome() {
    const tab = TABS.find((t) => t.id === ui.tab) || TABS[0];
    $("#pageTitle").textContent = tab.label;
    $("#pageDesc").textContent = tab.desc;
    document.querySelectorAll(".tab").forEach((el) => {
      const on = (el as HTMLElement).dataset.tab === ui.tab;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${ui.tab}`));
    if (!S) return;
    const s = S.snap;
    const online = s.state === "online";
    const count = (id: string, n: number | undefined) => {
      const el = $(`#count-${id}`);
      el.textContent = online && n ? String(n) : "";
      el.classList.toggle("hidden", !online || !n);
    };
    count("models", S.offered.length);
    count("combos", s.combos.length);
    count("providers", s.connections.length);

    const st = status();
    $("#brandDot").className = `dot ${st.level}`;
    $("#brandDot").title = st.label;
    $("#stats").innerHTML = `
      <div class="conn-line"><span class="dot ${st.level}"></span><strong>${st.label}</strong>${online && s.version?.current ? `<span class="muted">v${esc(s.version.current)}</span>` : ""}</div>
      <div class="conn-host" title="${esc(s.baseUrl)}">${esc(host(s.baseUrl))}</div>
      ${online ? `<div class="conn-stats">
        <span>${icon("copilot")}<span><strong>${S.offered.length}</strong> in Copilot</span></span>
        ${s.usage ? `<span>${icon("credit-card")}<span><strong>${usd(s.usage.totalCost)}</strong> in 30 days</span></span>` : ""}
        ${s.canManage ? "" : `<span>${icon("lock")}<span>Read-only · <button class="link-btn inline" data-action="signIn">sign in</button></span></span>`}
      </div>` : ""}`;

    const primary =
      s.state === "offline"
        ? `<button class="btn primary" data-action="startServer">${icon("play")}<span class="btn-label">Start OmniRoute</span></button>`
        : s.state === "needsKey"
          ? `<button class="btn primary" data-action="setApiKey">${icon("key")}<span class="btn-label">Set API key</span></button>`
          : ui.tab === "combos" && s.canManage
            ? `<button class="btn primary" data-action="new-combo">${icon("add")}<span class="btn-label">New combo</span></button>`
            : ui.tab === "providers" && s.canManage
              ? `<button class="btn primary" data-action="openWeb" title="Add connections and complete OAuth sign-ins in OmniRoute's web dashboard">${icon("add")}<span class="btn-label">Add provider</span></button>`
              : "";
    $("#pageActions").innerHTML =
      (online && s.refreshedAt ? `<span class="updated" title="${esc(new Date(s.refreshedAt).toLocaleString())}">Updated ${esc(ago(s.refreshedAt))}</span>` : "") +
      `<button class="icon-btn bordered" data-action="refresh" title="Refresh now" aria-label="Refresh">${icon("refresh")}</button>` +
      primary;
  }

  function connectScreen() {
    const s = S!.snap;
    if (s.state === "offline") {
      return `<div class="hero">
        <span class="hero-mark">${icon("radio-tower")}</span>
        <h2>OmniRoute isn't running</h2>
        <p>Nothing answered at <code>${esc(s.baseUrl)}</code>. Start a local gateway (it runs in a VS Code terminal) or point the extension at an existing one.</p>
        <div class="hero-actions">
          <button class="btn primary" data-action="startServer">${icon("play")}Start OmniRoute</button>
          <button class="btn" data-action="tab" data-tab="settings">${icon("settings-gear")}Connection settings</button>
          <button class="btn" data-action="refresh">${icon("refresh")}Retry</button>
        </div>
        <div class="feature-grid">
          ${feature("sparkle", "Zero-config auto routing", "auto, auto/coding, auto/fast, auto/cheap… pick the best available model per request.")}
          ${feature("git-merge", "Combos with fallback", "Chain models with 12+ strategies; quota and rate-limit aware.")}
          ${feature("server", "Hundreds of providers", "Free tiers, subscriptions and API keys behind one OpenAI-compatible endpoint.")}
          ${feature("fold", "Prompt compression", "Cut 15–95% of tokens with RTK and Caveman engines.")}
          ${feature("tools", "MCP tools", "Let agent mode inspect and steer the gateway.")}
          ${feature("graph", "Cost & latency analytics", "Per-model spend, p95 latency, cache savings.")}
        </div>
      </div>`;
    }
    return `<div class="hero">
      <span class="hero-mark">${icon("key")}</span>
      <h2>Connect to OmniRoute</h2>
      <p>The gateway at <code>${esc(s.baseUrl)}</code> is running but needs an API key for its <code>/v1</code> API${s.error ? ` (${esc(s.error)})` : ""}.</p>
      <div class="hero-actions">
        <button class="btn primary" data-action="signIn">${icon("sign-in")}Sign in with admin password</button>
        <button class="btn" data-action="setApiKey">${icon("key")}Paste an API key</button>
        <button class="btn" data-action="openWeb">${icon("link-external")}Open web dashboard</button>
      </div>
      <p class="muted small">${icon("shield")} Signing in stores only a session token and creates a key for VS Code. Everything is kept in VS Code's secret storage.</p>
    </div>`;
  }
  const feature = (ic: string, title: string, text: string) => `<div class="feature">${icon(ic)}<strong>${title}</strong><span>${text}</span></div>`;

  type Alert = { sev: "warn" | "info" | "ok"; icon: string; html: string; actions?: string };

  /** Items worth acting on; shown in the Overview's health card. */
  function attention(): Alert[] {
    const s = S!.snap;
    const out: Alert[] = [];
    if (s.health?.openBreakers.length)
      out.push({ sev: "warn", icon: "warning", html: `Circuit breaker open for <strong>${esc(s.health.openBreakers.map((b) => b.provider).join(", "))}</strong> — requests skip ${s.health.openBreakers.length === 1 ? "it" : "them"} until it recovers.`, actions: `<button class="btn small" data-action="resetBreakers">Reset breakers</button>` });
    if (s.cooldowns.length)
      out.push({ sev: "warn", icon: "watch", html: `${plural(s.cooldowns.length, "model")} cooling down after errors or rate limits: <strong>${esc(s.cooldowns.map((c) => c.model).join(", "))}</strong>.`, actions: `<button class="btn small" data-action="clearCooldowns">Clear cooldowns</button>` });
    const failing = s.connections.filter((c) => c.isActive && (c.testStatus === "error" || c.testStatus === "expired"));
    if (failing.length)
      out.push({ sev: "warn", icon: "plug", html: `${plural(failing.length, "provider connection")} failing: <strong>${esc(failing.map((c) => c.name).join(", "))}</strong>.`, actions: `<button class="btn small" data-action="tab" data-tab="providers">Review</button>` });
    if (!s.canManage)
      out.push({ sev: "info", icon: "lock", html: "Sign in to manage combos and providers, and to see analytics. Copilot and auto-routing work without it.", actions: `<button class="btn small primary" data-action="signIn">Sign in</button><button class="btn small" data-action="setManagementKey">Use a management key</button>` });
    if (s.version?.updateAvailable && s.version.latest)
      out.push({ sev: "info", icon: "arrow-circle-up", html: `OmniRoute <strong>${esc(s.version.latest)}</strong> is available (running ${esc(s.version.current)}).`, actions: `<button class="btn small" data-action="openWeb">Update from the web dashboard</button>` });
    if (S!.settings["mcp.enabled"] && s.mcp && !s.mcp.enabled)
      out.push({ sev: "info", icon: "tools", html: "OmniRoute's MCP server is disabled, so its tools aren't available in agent mode.", actions: `<button class="btn small" data-action="server-setting" data-key="mcpEnabled" data-value="true">Enable MCP</button>` });
    return out;
  }
  const alertRow = (a: Alert) =>
    `<div class="alert sev-${a.sev}"><span class="alert-icon">${icon(a.icon)}</span><span class="alert-text">${a.html}</span>${a.actions ? `<span class="alert-actions">${a.actions}</span>` : ""}</div>`;

  // ----------------------------------------------------------- overview

  const kpi = (ic: string, label: string, value: string, foot: string, tab?: string) =>
    `<${tab ? `button class="kpi" data-action="tab" data-tab="${tab}"` : `div class="kpi static"`}><span class="kpi-label">${label}</span><span class="kpi-icon">${icon(ic)}</span><span class="kpi-value">${value}</span>${foot ? `<span class="kpi-foot">${foot}</span>` : ""}</${tab ? "button" : "div"}>`;

  function renderOverview() {
    const s = S!.snap;
    const h = s.health;
    const u = s.usage;
    const autos = s.models.filter((m) => m.kind === "auto").length;
    const kpis = `<div class="kpis">
      ${kpi("copilot", "Copilot models", String(S!.offered.length), `${plural(autos, "auto model")} · ${plural(s.combos.filter((c) => c.isActive).length, "combo")}`, "models")}
      ${kpi("plug", "Providers", h?.activeCount !== undefined ? `${h.activeCount}<small>/${h.configuredCount ?? s.connections.length}</small>` : String(s.connections.length || "—"), h?.catalogCount ? `active · ${h.catalogCount} in the catalog` : s.canManage ? "connections" : "sign in to see", "providers")}
      ${kpi("pulse", "Requests · 30d", u ? u.totalRequests.toLocaleString() : "—", u?.successRatePct !== undefined ? `${u.successRatePct.toFixed(1)}% success${u.fallbackCount ? ` · ${u.fallbackCount} fallbacks` : ""}` : "all clients", "usage")}
      ${kpi("credit-card", "Spend · 30d", u ? usd(u.totalCost) : "—", u?.avgLatencyMs ? `avg latency ${Math.round(u.avgLatencyMs)}ms` : "estimated by OmniRoute", "usage")}
    </div>`;

    const alerts = attention();
    const warns = alerts.filter((a) => a.sev === "warn").length;
    const health = `<section class="card flush">
      <div class="health-head"><h2>${icon("pulse")}Health</h2>${warns ? pill("warn", `${plural(warns, "issue")}`) : alerts.length ? pill("accent", `${alerts.length} to review`) : pill("ok", "All clear")}</div>
      <div class="banners">${alerts.length ? alerts.map(alertRow).join("") : alertRow({ sev: "ok", icon: "check", html: "Everything looks good — no open circuit breakers, cooldowns or failing connections." })}</div>
    </section>`;

    const recent = s.routing.slice(0, 8);
    const recentHtml = recent.length
      ? `<ul class="list">${recent.map(routingRow).join("")}</ul>`
      : `<div class="empty small">No Copilot requests through OmniRoute yet.<br>Pick an OmniRoute model in the Copilot Chat model picker.</div>`;
    const top = (u?.byModel || []).slice(0, 6);
    const maxCost = Math.max(...top.map((r) => r.cost), 0.000001);
    const topHtml = top.length
      ? `<ul class="list">${top.map((r) => `<li class="list-row">${monogram(r.provider || r.key.split("/")[0], "sm")}
          <span class="list-main"><span class="list-title">${esc(r.key)}</span><span class="bar"><span style="width:${(r.cost / maxCost) * 100}%"></span></span></span>
          <span class="list-meta num">${r.requests.toLocaleString()} req</span><span class="list-meta num strong">${usd(r.cost)}</span></li>`).join("")}</ul>`
      : `<div class="empty small">${s.canManage ? "No usage recorded yet." : "Sign in to see usage."}</div>`;

    $("#panel-overview").innerHTML = `<div class="stack">
      ${kpis}
      ${health}
      ${u?.daily.length ? activity(u.daily, "Activity") : ""}
      <div class="split">
        <section class="block card"><div class="block-head"><h2 class="block-title">${icon("history")}Your recent Copilot requests</h2></div>${recentHtml}</section>
        <section class="block card"><div class="block-head"><h2 class="block-title">${icon("credit-card")}Top models by spend</h2><button class="link-btn" data-action="tab" data-tab="usage">All usage ${icon("arrow-right")}</button></div>${topHtml}</section>
      </div>
    </div>`;
  }

  function routingRow(r: RoutingRecord) {
    const detail = r.ok
      ? [r.served && r.served !== r.requested ? `→ ${r.served}` : "", r.provider, r.comboName && r.comboName !== r.requested ? `combo ${r.comboName}` : ""].filter(Boolean).join(" · ")
      : r.error || "failed";
    const meta = [r.latencyMs !== undefined ? `${Math.round(r.latencyMs)}ms` : r.durationMs ? `${r.durationMs}ms` : "", r.costUsd !== undefined ? usd(r.costUsd) : ""].filter(Boolean).join(" · ");
    return `<li class="list-row" title="${esc([r.decision, r.correlationId].filter(Boolean).join("\n"))}">
      <span class="mono-av sm ${r.ok ? "route" : "err"}" aria-hidden="true">${icon(r.ok ? (r.fallbackAttempts ? "debug-step-over" : "arrow-right") : "error")}</span>
      <span class="list-main"><span class="list-title">${esc(r.requested)}</span><span class="list-sub ${r.ok ? "" : "err"}">${esc(detail)}</span></span>
      <span class="list-meta num">${esc(meta)}</span><span class="list-meta">${esc(ago(r.at))}</span></li>`;
  }

  /** Rounds a chart maximum up to 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 × 10ⁿ. */
  function niceMax(v: number) {
    if (v <= 1) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => n * p >= v) || 10) * p;
  }

  /** Daily request bars with a y scale; hovering a bar shows its numbers in the header (see the mouseover listener). */
  function activity(daily: { date: string; requests: number; cost: number }[], title: string) {
    const total = daily.reduce((a, d) => a + d.requests, 0);
    const cost = daily.reduce((a, d) => a + d.cost, 0);
    const max = niceMax(Math.max(...daily.map((d) => d.requests)));
    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    const summary = `<strong>${total.toLocaleString()}</strong> requests · ${usd(cost)} · last ${daily.length} days`;
    const mid = daily[Math.floor((daily.length - 1) / 2)];
    const bars = daily
      .map((d) => {
        const tip = `<strong>${esc(day(d.date))}</strong> · ${plural(d.requests, "request")} · ${usd(d.cost)}`;
        return `<span class="spark-bar" style="height:${Math.max(2, (d.requests / max) * 100)}%" data-tip="${esc(tip)}"></span>`;
      })
      .join("");
    return `<section class="block card chart" data-default="${esc(summary)}">
      <div class="block-head"><h2 class="block-title">${icon("graph-line")}${title}</h2><span class="chart-readout">${summary}</span></div>
      <div class="chart-body">
        <div class="chart-y" aria-hidden="true"><span>${fmt(max)}</span><span>${fmt(max / 2)}</span><span>0</span></div>
        <div class="chart-plot"><div class="spark" role="img" aria-label="${esc(`Requests per day from ${day(daily[0].date)} to ${day(daily[daily.length - 1].date)}: ${total} in total`)}">${bars}</div></div>
        <div class="spark-axis" aria-hidden="true">${daily.map((d, i) => `<span>${i === 0 || i === daily.length - 1 || (daily.length > 4 && d === mid) ? esc(day(d.date)) : ""}</span>`).join("")}</div>
      </div>
    </section>`;
  }

  // ------------------------------------------------------------- models

  function renderModels() {
    const s = S!.snap;
    const set = S!.settings;
    const offered = new Set(S!.offered);
    const picked = new Set(set["copilot.models"]);
    const chat = s.models.filter(isChat);
    const providers = [...new Set(chat.filter((m) => m.kind === "model").map((m) => m.ownedBy))].sort();
    if (ui.provider && !providers.includes(ui.provider)) ui.provider = "";
    const rows = shownModels();
    const n = (k: string) => chat.filter((m) => (k === "copilot" ? offered.has(m.id) : m.kind === k)).length;
    const seg = [["all", "All", chat.length], ["copilot", "In Copilot", n("copilot")], ["auto", "Auto", n("auto")], ["combo", "Combos", n("combo")], ["model", "Catalog", n("model")]] as const;

    const panel = $("#panel-models");
    const focusedSearch = document.activeElement?.id === "mq";
    panel.innerHTML = `
      <div class="card flush offer">
        ${toggleRow("copilot.enabled", "Offer OmniRoute in Copilot Chat", "Registers OmniRoute as a model provider in the Copilot model picker.")}
        ${toggleRow("copilot.includeAutoModels", "Zero-config auto models", "<code>auto</code>, <code>auto/coding</code>, <code>auto/fast</code>… — OmniRoute picks a working model for every request.")}
        ${toggleRow("copilot.includeCombos", "Your combos", "Every enabled combo, with its fallback chain.")}
      </div>
      <div class="toolbar">
        <div class="row">
          <div class="search">${icon("search")}<input type="search" id="mq" placeholder="Search ${chat.length} models" value="${esc(ui.q)}" aria-label="Search models"></div>
          <select id="mprov" aria-label="Provider"><option value="">All providers</option>${providers.map((p) => `<option value="${esc(p)}" ${p === ui.provider ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>
          <div class="segmented" role="group" aria-label="Kind">${seg.map(([id, label, count]) => `<button data-action="kind" data-kind="${id}" class="${ui.kind === id ? "active" : ""}" aria-pressed="${ui.kind === id}">${label} <span class="n">${count}</span></button>`).join("")}</div>
        </div>
        <div class="bulkbar"><span class="grow">Showing <strong>${rows.length}</strong> of ${chat.length} · <strong>${offered.size}</strong> offered to Copilot</span>
          <button class="btn small" data-action="pick-shown" ${rows.some((m) => m.kind === "model" && !picked.has(m.id)) ? "" : "disabled"}>${icon("add")}Add shown</button>
          <button class="btn small" data-action="unpick-shown" ${rows.some((m) => picked.has(m.id)) ? "" : "disabled"}>${icon("remove")}Remove shown</button></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th class="col-check" title="Offered in Copilot"><span class="th-long">Copilot</span></th><th>Model</th><th class="col-kind">Source</th><th class="col-ctx">Context</th><th class="col-caps">Capabilities</th><th class="col-act"></th></tr></thead>
          <tbody>${rows.length ? rows.map((m) => modelRow(m, offered, picked)).join("") : `<tr><td colspan="6"><div class="empty">${icon("filter")}<strong>No models match</strong><br><br><button class="btn" data-action="reset-models">Clear filters</button></div></td></tr>`}</tbody>
        </table>
      </div>`;
    if (focusedSearch) {
      const el = $("#mq") as HTMLInputElement;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function modelRow(m: OmniModel, offered: Set<string>, picked: Set<string>) {
    const set = S!.settings;
    // auto/* and combos follow their group switch; catalog models are picked one by one.
    const governed = m.kind !== "model" && !picked.has(m.id);
    const groupOn = m.kind === "auto" ? set["copilot.includeAutoModels"] : set["copilot.includeCombos"];
    const checked = offered.has(m.id);
    const kind =
      m.kind === "auto" ? pill("accent", "auto-routing") : m.kind === "combo" ? pill("accent", "combo") : `<span class="prov">${monogram(m.ownedBy, "xs")}<span>${esc(m.ownedBy)}</span></span>`;
    const caps = (
      [["tools", "tools", "tool calling", m.toolCalling], ["eye", "vision", "vision", m.vision], ["lightbulb", "reasoning", "reasoning", m.reasoning]] as const
    ).map(([ic, cls, label, on]) => `<span class="cap ${cls} ${on ? "" : "off"}" title="${on ? label : `no ${label}`}">${icon(ic)}</span>`).join("");
    return `<tr class="${checked ? "selected" : ""}">
      <td class="col-check"><input type="checkbox" data-action="pick" data-id="${esc(m.id)}" ${checked ? "checked" : ""} ${governed ? `disabled title="${groupOn ? "Offered via the switch above" : "Turn on the switch above to offer these"}"` : `title="Offer in Copilot"`} aria-label="Offer ${esc(m.id)} in Copilot"></td>
      <td><div class="model-name" title="${esc(m.id)}">${esc(m.kind === "model" ? m.id : m.name)}</div><div class="model-sub">${esc(m.description || (m.kind === "auto" ? autoHelp(m.id) : m.kind === "model" ? m.name : "Combo"))}</div></td>
      <td class="col-kind">${kind}</td>
      <td class="col-ctx num">${kTok(m.contextLength)}</td>
      <td class="col-caps"><div class="caps">${caps}</div></td>
      <td class="col-act"><div class="act"><button class="icon-btn" data-action="copy" data-text="${esc(m.id)}" title="Copy model id">${icon("copy")}</button></div></td>
    </tr>`;
  }

  function toggleRow(key: keyof ExtSettings, title: string, desc: string) {
    return `<div class="setting"><div class="text"><div class="setting-title">${title}</div><div class="setting-desc">${desc}</div></div>
      <div class="control"><label class="switch"><input type="checkbox" data-setting="${key}" ${S!.settings[key] ? "checked" : ""} aria-label="${esc(title)}"><span></span></label></div></div>`;
  }

  // ------------------------------------------------------------- combos

  function renderCombos() {
    const s = S!.snap;
    const el = $("#panel-combos");
    if (el.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement!.tagName)) return;
    const d = ui.comboDraft;
    const chatIds = s.models.filter(isChat).map((m) => m.id);
    const form = d
      ? `<section class="card form-section combo-form">
          <div class="form-section-head"><span class="mono-av route">${icon("git-merge")}</span><span><h3>New combo</h3><p>Clients send the combo's name as the model. Members are tried according to the strategy — with "priority", in this order.</p></span></div>
          <div class="field-row">
            <div class="field"><label for="c-name">Name</label><input type="text" id="c-name" data-draft="name" value="${esc(d.name)}" placeholder="coding" spellcheck="false"></div>
            <div class="field"><label for="c-strategy">Strategy</label><select id="c-strategy" data-draft="strategy">${STRATEGIES.map((x) => `<option ${x === d.strategy ? "selected" : ""}>${x}</option>`).join("")}</select></div>
          </div>
          <div class="field"><label for="c-desc">Description <span class="muted">(optional)</span></label><input type="text" id="c-desc" data-draft="description" value="${esc(d.description)}"></div>
          <div class="field"><label>Models</label>
            <ol class="members">${d.models.map((id, i) => `<li class="member"><span class="order">${i + 1}</span>${monogram(id.split("/")[0], "sm")}<span class="m-text"><span class="model-name">${esc(id)}</span></span>
              <span class="member-actions">
                <button class="icon-btn" data-action="draft-move" data-index="${i}" data-dir="-1" ${i === 0 ? "disabled" : ""} title="Move up">${icon("arrow-up")}</button>
                <button class="icon-btn" data-action="draft-move" data-index="${i}" data-dir="1" ${i === d.models.length - 1 ? "disabled" : ""} title="Move down">${icon("arrow-down")}</button>
                <button class="icon-btn danger" data-action="draft-remove" data-index="${i}" title="Remove">${icon("close")}</button></span></li>`).join("") || `<li class="member empty-member muted">${icon("info")}Add at least one model.</li>`}</ol>
            <div class="row add-member"><input type="text" id="c-add" list="c-models" placeholder="Type a model id, e.g. anthropic/claude-sonnet-5-5" value="${esc(d.adding)}" spellcheck="false">
              <datalist id="c-models">${chatIds.map((id) => `<option value="${esc(id)}"></option>`).join("")}</datalist>
              <button class="btn" data-action="draft-add">${icon("add")}Add</button></div>
          </div>
          <div class="form-actions"><span class="grow"></span><button class="btn" data-action="draft-cancel">Cancel</button>
            <button class="btn primary" data-action="draft-save" ${d.name && d.models.length ? "" : "disabled"}>${icon("save")}Create combo</button></div>
        </section>`
      : "";
    const cards = s.combos
      .map((c) => `<article class="card route ${c.isActive ? "" : "off"}">
        <header class="p-head"><span class="mono-av route" aria-hidden="true">${icon("git-merge")}</span>
          <div class="p-title"><span class="p-name">${esc(c.name)}</span><span class="p-sub">${esc([c.strategy, c.models.length ? plural(c.models.length, "step") : "", c.contextLength ? `${kTok(c.contextLength)} context` : ""].filter(Boolean).join(" · "))}</span></div>
          <div class="p-tools">
            ${S!.offered.includes(c.name) ? pill("ok", "In Copilot") : c.isActive ? pill("", "Enabled") : pill("", "Disabled")}
            <button class="icon-btn" data-action="copy" data-text="${esc(c.name)}" title="Copy model id">${icon("copy")}</button>
            ${s.canManage ? `<button class="icon-btn danger" data-action="combo-delete" data-id="${esc(c.id)}" data-name="${esc(c.name)}" title="Delete combo">${icon("trash")}</button>
            <label class="switch" title="${c.isActive ? "Disable" : "Enable"} combo"><input type="checkbox" data-action="combo-active" data-id="${esc(c.id)}" ${c.isActive ? "checked" : ""} aria-label="Enable ${esc(c.name)}"><span></span></label>` : ""}
          </div>
        </header>
        ${c.description ? `<p class="route-desc">${esc(c.description)}</p>` : ""}
        ${c.models.length ? `<ol class="members chain">${c.models.map((st, i) => `<li class="member"><span class="order">${i + 1}</span>${monogram(st.providerId || (st.model || st.comboName || "?").split("/")[0], "sm")}
          <span class="m-text"><span class="model-name">${esc(st.model || st.comboName)}</span><span class="model-id">${esc(st.kind === "combo-ref" ? "nested combo" : st.providerId || "")}</span></span>
          ${c.strategy === "priority" ? `<span class="then">${i === 0 ? "primary" : "fallback"}</span>` : ""}</li>`).join("")}</ol>` : ""}
      </article>`)
      .join("");
    el.innerHTML = `<div class="routes">
      ${!s.canManage ? `<div class="notice">${icon("lock")}<span class="grow">Combos are listed from /v1/models. Sign in to see their members and to create or edit them.</span><button class="btn small primary" data-action="signIn">Sign in</button></div>` : ""}
      ${form}
      <div class="cards single">${cards || `<div class="card empty">${icon("git-merge")}<strong>No combos yet</strong><br>A combo is a named chain of models with a routing strategy, e.g. Claude first and GPT as backup.<br><br>${s.canManage ? `<button class="btn primary" data-action="new-combo">${icon("add")}New combo</button>` : ""}</div>`}</div>
    </div>`;
  }

  // ---------------------------------------------------------- providers

  /** Quota bars for one connection. Bars show usable headroom; the tooltip carries the raw value. */
  function quotaBlock(limits: ProviderLimits | undefined, cutoff: number, warn: number) {
    if (!limits) return "";
    const windows = limits.windows.filter((w) => w.unlimited || w.remainingPercentage !== undefined);
    if (!windows.length) return limits.message ? `<div class="note">${icon("info")}<span>${esc(limits.message)}</span></div>` : "";
    const rows = windows
      .map((w) => {
        const counts = windowCounts(w);
        const reset = resetIn(w.resetAt);
        const meta = [counts, reset && `resets ${reset}`].filter(Boolean).join(" · ");
        if (w.unlimited) {
          return `<li class="quota-row"><span class="quota-label">${esc(w.label)}</span>
            <span class="bar unlimited"><span style="width:100%"></span></span>
            <span class="quota-num muted">${esc(meta || "unlimited")}</span></li>`;
        }
        const eff = effRemaining(w.remainingPercentage, cutoff) ?? 0;
        const sev = eff <= 0 ? "err" : eff <= warn ? "warn" : "ok";
        const tip = `${w.remainingPercentage!.toFixed(0)}% raw upstream · OmniRoute stops routing at ${cutoff}% remaining${meta ? ` · ${meta}` : ""}`;
        return `<li class="quota-row" title="${esc(tip)}"><span class="quota-label">${esc(w.label)}</span>
          <span class="bar ${sev}"><span style="width:${eff.toFixed(1)}%"></span></span>
          <span class="quota-num ${sev === "ok" ? "" : sev}">${eff.toFixed(0)}%${meta ? ` <span class="muted">· ${esc(meta)}</span>` : ""}</span></li>`;
      })
      .join("");
    return `<ul class="quota">${rows}</ul>`;
  }

  function renderProviders() {
    const s = S!.snap;
    const el = $("#panel-providers");
    if (!s.canManage) {
      el.innerHTML = `<div class="card empty">${icon("lock")}<strong>Sign in to see provider connections</strong><br>Connections hold your upstream API keys and OAuth accounts, so they need management access.<br><br><button class="btn primary" data-action="signIn">Sign in</button></div>`;
      return;
    }
    const h = s.health;
    const q = s.quota;
    const cutoff = q?.cutoffPercent ?? 2;
    const warn = q?.warnPercent ?? 20;
    const states = s.connections.map((c) => {
      const limited = !!c.rateLimitedUntil && Date.parse(c.rateLimitedUntil) > Date.now();
      const bad = c.testStatus === "error" || c.testStatus === "expired";
      return { c, limited, bad, key: !c.isActive ? "off" : bad ? "bad" : limited ? "limited" : c.testStatus === "active" ? "ok" : "untested" };
    });
    const tally = (k: string) => states.filter((x) => x.key === k).length;
    const summary = (
      [["ok", "ok", "healthy"], ["bad", "err", "failing"], ["limited", "warn", "rate-limited"], ["untested", "", "untested"], ["off", "", "disabled"]] as const
    )
      .filter(([k]) => tally(k))
      .map(([k, dot, label]) => `<span><span class="dot ${dot}"></span><strong>${tally(k)}</strong> ${label}</span>`)
      .join("");
    const quotaNote = q?.lastAutoSyncAt
      ? `<p class="muted small">Quota read ${esc(ago(q.lastAutoSyncAt))}${q.intervalMinutes ? `, refreshed by OmniRoute every ${q.intervalMinutes}m` : ""}. Bars show usable headroom; routing stops at ${cutoff}% remaining.</p>`
      : "";
    const head = `<div class="section-head"><h2>${plural(s.connections.length, "connection")}${h?.catalogCount ? ` <span class="muted">· ${h.catalogCount} providers available</span>` : ""}</h2>
      <span class="grow"></span><div class="summary">${summary}</div></div>${quotaNote}`;
    const cards = states
      .map(({ c, limited, bad }) => {
        const state = !c.isActive ? pill("", "Disabled") : bad ? pill("err", c.testStatus === "expired" ? "Expired" : "Error", c.lastError || "") : limited ? pill("warn", "Rate-limited") : c.testStatus === "active" ? pill("ok", "Healthy") : pill("", "Untested");
        return `<article class="card provider ${c.isActive ? "" : "off"} ${c.isActive && bad ? "bad" : ""}">
          <header class="p-head">${monogram(c.provider)}
            <div class="p-title"><span class="p-name">${esc(c.name)}</span><span class="p-sub">${esc([c.provider, c.authType === "oauth" ? "OAuth" : c.authType === "apikey" ? "API key" : c.authType, c.email].filter(Boolean).join(" · "))}</span></div>
            <div class="p-tools">${state}
            <label class="switch" title="${c.isActive ? "Disable" : "Enable"} connection"><input type="checkbox" data-action="conn-active" data-id="${esc(c.id)}" ${c.isActive ? "checked" : ""} aria-label="Enable ${esc(c.name)}"><span></span></label></div>
          </header>
          ${c.lastError ? `<div class="note err">${icon("error")}<span title="${esc(c.lastError)}">${esc(c.lastError)}</span></div>` : ""}
          ${limited ? `<div class="note warn">${icon("watch")}<span>Rate-limited until ${esc(new Date(c.rateLimitedUntil!).toLocaleTimeString())}</span></div>` : ""}
          ${quotaBlock(q?.byConnection[c.id], cutoff, warn)}
          <footer class="p-actions">
            <button class="btn small" data-action="conn-test" data-id="${esc(c.id)}">${icon("beaker")}Test</button>
            <span class="grow"></span><span class="muted small">${c.lastTested ? `Tested ${esc(ago(c.lastTested))}` : "Never tested"}${c.priority !== undefined ? ` · priority ${c.priority}` : ""}</span>
          </footer>
        </article>`;
      })
      .join("");
    el.innerHTML = head + (cards ? `<div class="cards">${cards}</div>` : `<div class="card empty">${icon("plug")}<strong>No provider connections yet</strong><br>Add API keys and OAuth accounts in OmniRoute's web dashboard.<br><br><button class="btn primary" data-action="openWeb">Add a provider</button></div>`);
  }

  // -------------------------------------------------------------- usage

  function renderUsage() {
    const s = S!.snap;
    const el = $("#panel-usage");
    if (!s.canManage) {
      el.innerHTML = `<div class="card empty">${icon("lock")}<strong>Sign in to see usage analytics</strong><br>Your own Copilot requests are listed on the Overview.<br><br><button class="btn primary" data-action="signIn">Sign in</button></div>`;
      return;
    }
    const u = s.usage;
    const table = (title: string, ic: string, rows: NonNullable<typeof u>["byModel"]) => {
      const max = Math.max(...rows.map((r) => r.cost), 0.000001);
      return `<section class="block card"><div class="block-head"><h2 class="block-title">${icon(ic)}${title}</h2></div>
        ${rows.length ? `<table class="plain"><thead><tr><th>Name</th><th class="num">Requests</th><th class="num">Avg latency</th><th class="num">Success</th><th class="num">Cost</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td><div class="model-name">${esc(r.key)}</div><span class="bar"><span style="width:${(r.cost / max) * 100}%"></span></span></td>
          <td class="num">${r.requests.toLocaleString()}</td><td class="num">${r.avgLatencyMs ? `${Math.round(r.avgLatencyMs)}ms` : "—"}</td>
          <td class="num">${r.successRatePct !== undefined ? `<span class="${r.successRatePct < 90 ? "warn" : ""}">${r.successRatePct.toFixed(0)}%</span>` : "—"}</td><td class="num strong">${usd(r.cost)}</td></tr>`).join("")}
        </tbody></table>` : `<div class="empty small">No data yet.</div>`}</section>`;
    };
    const ar = s.autoRouting;
    const arTotal = ar ? Object.values(ar.variants).reduce((a, b) => a + b, 0) : 0;
    const calls = s.recentCalls.slice(0, 15);
    el.innerHTML = `<div class="stack">
      <div class="kpis">
        ${kpi("pulse", "Requests · 30d", u ? u.totalRequests.toLocaleString() : "—", "")}
        ${kpi("credit-card", "Spend · 30d", u ? usd(u.totalCost) : "—", "")}
        ${kpi("pass", "Success rate", u?.successRatePct !== undefined ? `${u.successRatePct.toFixed(1)}%` : "—", "")}
        ${kpi("debug-step-over", "Fallbacks", u?.fallbackCount !== undefined ? u.fallbackCount.toLocaleString() : "—", "")}
      </div>
      ${u?.daily.length ? activity(u.daily, "Daily requests") : ""}
      ${table("By model", "symbol-class", u?.byModel || [])}
      <div class="split">
        ${table("By provider", "server", u?.byProvider || [])}
        <section class="block card"><div class="block-head"><h2 class="block-title">${icon("sparkle")}Auto-routing</h2><span class="block-aside">${ar ? plural(ar.totalRequests, "request") : ""}</span></div>
          ${ar && arTotal ? `<ul class="list">${Object.entries(ar.variants).sort((a, b) => b[1] - a[1]).map(([v, n]) => `<li class="list-row"><span class="list-main"><span class="list-title">${esc(v === "default" ? "auto" : `auto/${v}`)}</span><span class="bar"><span style="width:${(n / arTotal) * 100}%"></span></span></span><span class="list-meta num">${n}</span></li>`).join("")}</ul>
            ${ar.topProviders.length ? `<p class="muted small">Served mostly by ${esc(ar.topProviders.slice(0, 3).map((p) => `${p.provider} (${p.count})`).join(", "))}</p>` : ""}` : `<div class="empty small">No auto-routed requests yet.</div>`}
        </section>
      </div>
      <section class="block card"><div class="block-head"><h2 class="block-title">${icon("list-flat")}Recent calls · all clients</h2></div>
        ${calls.length ? `<table class="plain"><thead><tr><th>Time</th><th>Requested → served</th><th>Provider</th><th class="num">Tokens in / out</th><th class="num">Duration</th><th>Status</th></tr></thead><tbody>
        ${calls.map((c) => `<tr><td class="muted">${esc(ago(c.timestamp))}</td><td><div class="model-name">${esc(c.requestedModel && c.requestedModel !== c.model ? `${c.requestedModel} → ${c.model}` : c.model)}</div>${c.comboName ? `<div class="model-id">combo ${esc(c.comboName)}</div>` : ""}</td>
          <td>${esc(c.provider)}${c.account ? `<div class="model-id">${esc(c.account)}</div>` : ""}</td><td class="num">${c.tokensIn ?? "—"} / ${c.tokensOut ?? "—"}</td><td class="num">${c.durationMs}ms</td>
          <td>${c.status >= 200 && c.status < 300 ? pill("ok", String(c.status)) : pill("err", String(c.status || "ERR"), c.error || "")}</td></tr>`).join("")}
        </tbody></table>` : `<div class="empty small">No calls logged yet.</div>`}
      </section>
    </div>`;
  }

  // ----------------------------------------------------------- settings

  function renderSettings() {
    const el = $("#panel-settings");
    if (el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement!.tagName)) return;
    if (!S) return;
    const s = S.snap;
    const set = S.settings;
    const toc: [string, string, string][] = [];
    const section = (id: string, ic: string, title: string, desc: string, body: string) => {
      toc.push([id, ic, title]);
      return `<section class="card settings-section" id="set-${id}"><div class="settings-head">${icon(ic)}<div><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ""}</div></div>${body}</section>`;
    };
    const row = (title: string, desc: string, control: string) =>
      `<div class="setting"><div class="text"><div class="setting-title">${title}</div><div class="setting-desc">${desc}</div></div><div class="control">${control}</div></div>`;
    const select = (key: keyof ExtSettings, options: [string, string][]) =>
      `<select data-setting="${key}" aria-label="${key}">${options.map(([v, l]) => `<option value="${v}" ${set[key] === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const sw = (key: keyof ExtSettings, label: string) => `<label class="switch"><input type="checkbox" data-setting="${key}" ${set[key] ? "checked" : ""} aria-label="${esc(label)}"><span></span></label>`;
    const auth = s.auth;
    const yes = (b: boolean, on: string, off: string) => (b ? pill("ok", on) : pill("", off));
    const comp = s.compression;
    const cache = s.cache || {};
    const cacheBits = Object.entries(cache).filter(([, v]) => typeof v === "number").slice(0, 4).map(([k, v]) => `${k} ${k.toLowerCase().includes("rate") && (v as number) <= 1 ? `${Math.round((v as number) * 100)}%` : v}`).join(" · ");

    const sections = [
      section("connection", "plug", "Connection", `Gateway at <code>${esc(s.baseUrl)}</code> — ${s.state === "online" ? "connected" : s.state === "needsKey" ? "running, API key needed" : "not reachable"}.`,
        row("Gateway URL", "Where OmniRoute runs. Default port is 20128.", `<button class="btn" data-action="openSettings">${icon("edit")}Change</button><button class="btn" data-action="copyBaseUrl">${icon("copy")}Copy /v1 URL</button>`) +
        row("API key", "Used for Copilot chats, the model list and MCP.", `${yes(auth.hasApiKey, "Stored", "Not set")}<button class="btn" data-action="setApiKey">${icon("key")}${auth.hasApiKey ? "Replace" : "Set"}</button><button class="btn" data-action="createApiKey" ${s.canManage ? "" : "disabled"}>${icon("add")}Create</button>`) +
        row("Management access", "Combos, providers, analytics and gateway controls. Sign in with the admin password, or use a key with the <code>manage</code> scope.", `${yes(s.canManage, auth.signedIn ? "Signed in" : "Management key", "Read-only")}<button class="btn" data-action="signIn">${icon("sign-in")}Sign in</button><button class="btn" data-action="setManagementKey">${icon("shield")}Key</button>`) +
        row("Forget credentials", "Sign out and remove every stored key from this machine.", `<button class="btn danger" data-action="signOut">${icon("sign-out")}Sign out</button>`)),

      section("server", "server-process", "Local server", "Start OmniRoute from VS Code. It runs in a terminal named “OmniRoute”, so you can see its logs.",
        row("Launch with", "npx needs no install; global uses <code>npm i -g omniroute</code>; Docker runs the official image.", select("server.launchMode", [["npx", "npx"], ["global", "Global install"], ["docker", "Docker"], ["custom", "Custom command"]])) +
        row("Localhost only", "Bind to 127.0.0.1 so other machines can't reach the gateway.", sw("server.localhostOnly", "Localhost only")) +
        row("Start with VS Code", "Launch when VS Code starts if nothing is running yet.", sw("server.autoStart", "Start with VS Code")) +
        row("Control", s.state === "offline" ? "Not running." : `Running${S.launchedHere ? " — started from this window" : ""}.`,
          s.state === "offline"
            ? `<button class="btn primary" data-action="startServer">${icon("play")}Start</button>`
            : `<button class="btn" data-action="restartServer" ${s.canManage ? "" : "disabled"}>${icon("debug-restart")}Restart</button><button class="btn danger" data-action="stopServer">${icon("debug-stop")}Stop</button>${S.launchedHere ? `<button class="btn" data-action="showServerTerminal">${icon("terminal")}Terminal</button>` : ""}`)),

      section("copilot", "copilot", "Copilot Chat", "How Copilot requests are sent through OmniRoute.",
        row("Prompt compression", "Sent as <code>X-OmniRoute-Compression</code>. “Gateway default” uses the server-wide setting.", select("chat.compression", [["server", "Gateway default"], ...COMPRESSION.map((m) => [m, m] as [string, string])])) +
        row("Bypass response cache", "Always ask a model, even for repeated prompts.", sw("chat.bypassCache", "Bypass response cache")) +
        row("Don't use memory", "Keep Copilot requests out of OmniRoute's persistent memory.", sw("chat.disableMemory", "Don't use memory")) +
        row("Show reasoning", "Render the model's reasoning as a quoted block above the answer.", sw("chat.showReasoning", "Show reasoning")) +
        row("Routing in the status bar", "Show which provider and model answered, with latency and cost.", select("chat.routingNotice", [["statusBar", "Show"], ["off", "Hide"]])) +
        row("MCP tools in agent mode", "Register OmniRoute's MCP server with VS Code.", sw("mcp.enabled", "MCP tools"))),

      s.canManage ? section("gateway", "radio-tower", "Gateway", "Server-wide settings — they apply to every client of this OmniRoute.",
        row("Default compression", comp ? (comp.enabled ? `Currently <strong>${esc(comp.defaultMode)}</strong>.` : "Currently off.") : "Unavailable.",
          `<select data-action="compression" aria-label="Default compression">${COMPRESSION.map((m) => `<option value="${m}" ${comp && ((comp.enabled && comp.defaultMode === m) || (!comp.enabled && m === "off")) ? "selected" : ""}>${m}</option>`).join("")}</select>`) +
        row("Semantic response cache", cacheBits ? esc(cacheBits) : "Reuses answers to similar prompts.", `<button class="btn" data-action="clearCache">${icon("clear-all")}Clear cache</button>`) +
        row("MCP server", s.mcp ? `${s.mcp.enabled ? "Enabled" : "Disabled"}${s.mcp.transport ? ` · ${esc(s.mcp.transport)}` : ""}${s.mcp.calls24h !== undefined ? ` · ${s.mcp.calls24h} calls in 24h` : ""}${s.mcp.enabled && s.mcp.transport && s.mcp.transport !== "streamable-http" ? " — VS Code needs the streamable-http transport." : ""}` : "Status unavailable.",
          `<label class="switch"><input type="checkbox" data-action="server-setting" data-key="mcpEnabled" ${s.mcp?.enabled ? "checked" : ""} aria-label="MCP server"><span></span></label>`) +
        row("Circuit breakers", s.health?.openBreakers.length ? `Open: ${esc(s.health.openBreakers.map((b) => b.provider).join(", "))}` : "All closed.", `<button class="btn" data-action="resetBreakers">${icon("debug-restart")}Reset</button>`) +
        row("Model cooldowns", s.cooldowns.length ? esc(s.cooldowns.map((c) => `${c.model}${c.remainingMs ? ` (${Math.ceil(c.remainingMs / 1000)}s)` : ""}`).join(", ")) : "None.", `<button class="btn" data-action="clearCooldowns" ${s.cooldowns.length ? "" : "disabled"}>${icon("clear-all")}Clear</button>`)) : "",

      section("cli", "terminal", "Command-line tools", "OmniRoute can launch or configure coding CLIs against this gateway.",
        row("Run a CLI", "Start Claude Code, Codex, Aider, Goose, OpenCode, Qwen or Gemini CLI routed through OmniRoute. The key is passed via the terminal environment.", `<button class="btn" data-action="runCli">${icon("play")}Run…</button>`) +
        row("Configure a tool", "Write a tool's config (Cursor, Cline, Continue…) to use this gateway.", `<button class="btn" data-action="configureCli">${icon("tools")}Configure…</button>`) +
        row("Logs", "The extension's log.", `<button class="btn" data-action="showLogs">${icon("output")}Show logs</button>`)),
    ].join("");

    el.innerHTML = `<div class="settings-layout">
      <div class="settings">${sections}</div>
      <aside class="toc" aria-label="On this page"><div class="nav-label">On this page</div>${toc.map(([id, ic, title]) => `<button data-action="jump" data-target="set-${id}">${icon(ic)}${title}</button>`).join("")}</aside>
    </div>`;
  }

  // ------------------------------------------------------------- events

  const simple = new Set([
    "refresh", "startServer", "stopServer", "restartServer", "showServerTerminal", "signIn", "signOut", "setApiKey", "setManagementKey", "createApiKey",
    "openWeb", "clearCache", "resetBreakers", "clearCooldowns", "runCli", "configureCli", "copyBaseUrl", "openSettings", "showLogs",
  ]);

  const actions: Record<string, (el: HTMLElement) => void> = {
    tab: (el) => {
      ui.tab = el.dataset.tab as DashboardTab;
      persist();
      render();
    },
    jump: (el) => document.getElementById(el.dataset.target || "")?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
    kind: (el) => {
      ui.kind = el.dataset.kind as any;
      persist();
      renderModels();
    },
    "reset-models": () => {
      Object.assign(ui, { q: "", kind: "all", provider: "" });
      persist();
      renderModels();
    },
    copy: (el) => {
      void navigator.clipboard?.writeText(el.dataset.text || "").then(
        () => toast(`Copied ${el.dataset.text}`),
        () => toast("Copy failed", false)
      );
    },
    "pick-shown": () => post({ type: "togglePicked", ids: shownModels().filter((m) => m.kind === "model").map((m) => m.id), on: true }),
    "unpick-shown": () => post({ type: "togglePicked", ids: shownModels().map((m) => m.id), on: false }),
    "new-combo": () => {
      ui.tab = "combos";
      ui.comboDraft = { name: "", strategy: "priority", models: [], description: "", adding: "" };
      persist();
      render();
      (document.getElementById("c-name") as HTMLInputElement | null)?.focus();
    },
    "draft-add": () => {
      const d = ui.comboDraft;
      const input = document.getElementById("c-add") as HTMLInputElement | null;
      const v = (input?.value || "").trim();
      if (!d || !v) return;
      if (!d.models.includes(v)) d.models.push(v);
      d.adding = "";
      rerenderCombos("c-add");
    },
    "draft-remove": (el) => {
      ui.comboDraft?.models.splice(Number(el.dataset.index), 1);
      rerenderCombos();
    },
    "draft-move": (el) => {
      const d = ui.comboDraft;
      if (!d) return;
      const i = Number(el.dataset.index);
      const j = i + Number(el.dataset.dir);
      if (j < 0 || j >= d.models.length) return;
      [d.models[i], d.models[j]] = [d.models[j], d.models[i]];
      rerenderCombos();
    },
    "draft-cancel": () => {
      ui.comboDraft = null;
      rerenderCombos();
    },
    "draft-save": () => {
      const d = ui.comboDraft;
      if (!d || !d.name || !d.models.length) return;
      if (!/^[a-zA-Z0-9_./-]+$/.test(d.name)) return toast("Combo names may use letters, digits and - _ . /", false);
      post({ type: "createCombo", name: d.name, strategy: d.strategy, models: d.models, description: d.description || undefined });
    },
    "combo-delete": (el) => post({ type: "deleteCombo", id: el.dataset.id!, name: el.dataset.name! }),
    "conn-test": (el) => post({ type: "testConnection", id: el.dataset.id! }),
  };

  function rerenderCombos(focusId?: string) {
    const active = document.activeElement as HTMLElement | null;
    active?.blur();
    renderCombos();
    if (focusId) (document.getElementById(focusId) as HTMLElement | null)?.focus();
  }

  /** The chat models that pass the Models page's search, kind and provider filters. */
  function shownModels(): OmniModel[] {
    const offered = new Set(S!.offered);
    const q = ui.q.trim().toLowerCase();
    return S!.snap.models.filter(isChat).filter(
      (m) =>
        (!q || `${m.id} ${m.name} ${m.ownedBy}`.toLowerCase().includes(q)) &&
        (ui.kind === "all" || (ui.kind === "copilot" ? offered.has(m.id) : m.kind === ui.kind)) &&
        (!ui.provider || m.ownedBy === ui.provider)
    );
  }

  document.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement)?.closest?.("[data-action]") as HTMLElement | null;
    if (!el || (el as HTMLButtonElement).disabled || el.tagName === "INPUT" || el.tagName === "SELECT") return;
    const a = el.dataset.action!;
    if (simple.has(a)) post({ type: a as any });
    else if (a === "server-setting") post({ type: "setServerSetting", key: el.dataset.key as any, value: el.dataset.value === "true" });
    else actions[a]?.(el);
  });

  // Chart readout: the hovered bar's numbers replace the summary in the chart header.
  const readout = (chart: HTMLElement, html?: string) => {
    const out = chart.querySelector(".chart-readout");
    if (out) out.innerHTML = html ?? chart.dataset.default ?? "";
  };
  document.addEventListener("mouseover", (ev) => {
    const bar = (ev.target as HTMLElement)?.closest?.(".spark-bar") as HTMLElement | null;
    const chart = bar?.closest(".chart") as HTMLElement | null;
    if (bar && chart) readout(chart, bar.dataset.tip);
  });
  document.addEventListener("mouseout", (ev) => {
    const chart = (ev.target as HTMLElement)?.closest?.(".chart") as HTMLElement | null;
    if (chart && !chart.contains(ev.relatedTarget as Node | null)) readout(chart);
  });

  document.addEventListener("change", (ev) => {
    const el = ev.target as HTMLInputElement;
    const a = el.dataset.action;
    if (el.dataset.setting) {
      post({ type: "setSetting", key: el.dataset.setting as keyof ExtSettings, value: el.type === "checkbox" ? el.checked : el.value });
    } else if (a === "pick") {
      post({ type: "togglePicked", ids: [el.dataset.id!], on: el.checked });
    } else if (a === "combo-active") {
      post({ type: "toggleCombo", id: el.dataset.id!, active: el.checked });
    } else if (a === "conn-active") {
      post({ type: "toggleConnection", id: el.dataset.id!, active: el.checked });
    } else if (a === "server-setting") {
      post({ type: "setServerSetting", key: el.dataset.key as any, value: el.checked });
    } else if (a === "compression") {
      post(el.value === "off" ? { type: "setCompression", enabled: false } : { type: "setCompression", enabled: true, defaultMode: el.value });
    } else if (el.id === "mprov") {
      ui.provider = el.value;
      persist();
      renderModels();
    } else if (el.dataset.draft && ui.comboDraft) {
      (ui.comboDraft as any)[el.dataset.draft] = el.value;
    }
  });

  document.addEventListener("input", (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.id === "mq") {
      ui.q = el.value;
      persist();
      renderModels();
    } else if (el.dataset.draft && ui.comboDraft) {
      (ui.comboDraft as any)[el.dataset.draft] = el.value;
      const save = document.querySelector('[data-action="draft-save"]') as HTMLButtonElement | null;
      if (save) save.disabled = !(ui.comboDraft.name && ui.comboDraft.models.length);
    } else if (el.id === "c-add" && ui.comboDraft) {
      ui.comboDraft.adding = el.value;
    }
  });

  document.addEventListener("keydown", (ev) => {
    const el = ev.target as HTMLElement;
    if (ev.key === "Enter" && el.id === "c-add") {
      ev.preventDefault();
      actions["draft-add"](el);
    } else if (ev.key === "/" && ui.tab === "models" && !/INPUT|TEXTAREA|SELECT/.test(el.tagName)) {
      ev.preventDefault();
      ($("#mq") as HTMLInputElement | null)?.focus();
    } else if (ev.key === "Escape" && ui.comboDraft && el.closest?.(".combo-form")) {
      actions["draft-cancel"](el);
    }
  });

  window.addEventListener("message", (ev: MessageEvent<HostMessage>) => {
    const msg = ev.data;
    if (msg.type === "state") {
      S = msg.state;
      render();
    } else if (msg.type === "focus") {
      ui.tab = msg.tab;
      persist();
      render();
    } else if (msg.type === "result") {
      toast(msg.text, msg.ok);
      if (msg.ok && ui.comboDraft) {
        ui.comboDraft = null;
        rerenderCombos();
      }
    }
  });

  render();
  post({ type: "ready" });
})();
