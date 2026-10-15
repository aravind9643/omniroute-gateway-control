import * as vscode from "vscode";
import { isChatModel } from "./client";
import { describeRouting, formatUsd } from "./stream";
import type { Snapshot, Store } from "./store";
import type { Combo, Connection, OmniModel } from "./types";

export type Node =
  | { kind: "server" }
  | { kind: "serverInfo"; label: string; description?: string; icon: string; tooltip?: string }
  | { kind: "signIn" }
  | { kind: "group"; id: "copilot" | "combos" | "connections" | "catalog" | "keys" | "mcp" | "recent"; label: string; count?: number }
  | { kind: "provider"; provider: string; models: OmniModel[] }
  | { kind: "model"; model: OmniModel; inCopilotGroup?: boolean }
  | { kind: "combo"; combo: Combo }
  | { kind: "step"; label: string; description?: string; icon: string }
  | { kind: "connection"; connection: Connection }
  | { kind: "apiKey"; id: string; name: string; description: string; active: boolean }
  | { kind: "info"; label: string; description?: string; icon: string; tooltip?: string; command?: vscode.Command };


export class OmniTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly _sub: vscode.Disposable;

  constructor(private readonly _store: Store) {
    this._sub = _store.onDidChange(() => this._onDidChange.fire(undefined));
  }

  private get s(): Snapshot {
    return this._store.snapshot;
  }

  getChildren(node?: Node): Node[] {
    const s = this.s;
    if (!node) {
      // Offline / needsKey states are covered by the view's welcome content.
      if (s.state !== "online") return [];
      const chat = s.models.filter(isChatModel);
      const roots: Node[] = [{ kind: "server" }];
      if (!s.canManage) roots.push({ kind: "signIn" });
      roots.push({ kind: "group", id: "copilot", label: vscode.l10n.t("In Copilot"), count: this._store.copilotModels().length });
      roots.push({ kind: "group", id: "combos", label: vscode.l10n.t("Combos"), count: s.combos.length });
      if (s.canManage) roots.push({ kind: "group", id: "connections", label: vscode.l10n.t("Provider connections"), count: s.connections.length });
      roots.push({ kind: "group", id: "catalog", label: vscode.l10n.t("Model catalog"), count: chat.filter((m) => m.kind === "model").length });
      if (s.canManage) roots.push({ kind: "group", id: "keys", label: vscode.l10n.t("API keys"), count: s.keys.length });
      if (s.canManage) roots.push({ kind: "group", id: "mcp", label: vscode.l10n.t("MCP server") });
      if (s.routing.length) roots.push({ kind: "group", id: "recent", label: vscode.l10n.t("Recent requests"), count: s.routing.length });
      return roots;
    }
    switch (node.kind) {
      case "server":
        return this._serverInfo();
      case "group":
        return this._group(node.id);
      case "provider":
        return node.models.map((model) => ({ kind: "model", model }));
      case "combo":
        return node.combo.models.map((st, i) =>
          st.kind === "combo-ref"
            ? { kind: "step", label: `${i + 1}. ${st.comboName}`, description: vscode.l10n.t("combo"), icon: "references" }
            : { kind: "step", label: `${i + 1}. ${st.model}`, description: st.providerId, icon: "symbol-class" }
        );
      default:
        return [];
    }
  }

  private _serverInfo(): Node[] {
    const s = this.s;
    const h = s.health;
    const out: Node[] = [{ kind: "serverInfo", label: s.baseUrl, description: vscode.l10n.t("base URL"), icon: "link" }];
    if (s.version?.current)
      out.push({
        kind: "serverInfo",
        label: `v${s.version.current}`,
        description: s.version.updateAvailable && s.version.latest ? vscode.l10n.t("update {0} available", s.version.latest) : vscode.l10n.t("up to date"),
        icon: s.version.updateAvailable ? "arrow-circle-up" : "versions",
      });
    if (h?.catalogCount !== undefined)
      out.push({ kind: "serverInfo", label: vscode.l10n.t("{0} of {1} providers configured", h.configuredCount ?? 0, h.catalogCount), description: vscode.l10n.t("{0} active", h.activeCount ?? 0), icon: "server" });
    if (h?.openBreakers.length)
      out.push({ kind: "serverInfo", label: vscode.l10n.t("{0} circuit breaker(s) open", h.openBreakers.length), description: h.openBreakers.map((b) => b.provider).join(", "), icon: "warning" });
    if (s.cooldowns.length)
      out.push({ kind: "serverInfo", label: vscode.l10n.t("{0} model(s) cooling down", s.cooldowns.length), description: s.cooldowns.map((c) => c.model).join(", "), icon: "watch" });
    if (s.usage) out.push({ kind: "serverInfo", label: vscode.l10n.t("{0} requests · {1}", s.usage.totalRequests, formatUsd(s.usage.totalCost)), description: vscode.l10n.t("last 30 days"), icon: "graph" });
    return out;
  }

  private _group(id: string): Node[] {
    const s = this.s;
    switch (id) {
      case "copilot": {
        const models = this._store.copilotModels();
        return models.length
          ? models.map((model) => ({ kind: "model", model, inCopilotGroup: true }))
          : [{ kind: "info", label: vscode.l10n.t("Nothing offered yet"), description: vscode.l10n.t("tick models in the catalog"), icon: "info", command: { command: "omniroute.selectModels", title: "" } }];
      }
      case "combos":
        return s.combos.length
          ? s.combos.map((combo) => ({ kind: "combo", combo }))
          : [{ kind: "info", label: vscode.l10n.t("No combos yet"), icon: "info", command: s.canManage ? { command: "omniroute.createCombo", title: "" } : undefined }];
      case "connections":
        return [...s.connections].sort((a, b) => Number(b.isActive) - Number(a.isActive) || (a.priority ?? 0) - (b.priority ?? 0)).map((connection) => ({ kind: "connection", connection }));
      case "catalog": {
        const byProvider = new Map<string, OmniModel[]>();
        for (const m of s.models) {
          if (m.kind !== "model" || !isChatModel(m)) continue;
          const list = byProvider.get(m.ownedBy) ?? [];
          list.push(m);
          byProvider.set(m.ownedBy, list);
        }
        return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([provider, models]) => ({ kind: "provider", provider, models }));
      }
      case "keys":
        return s.keys.map((k) => ({
          kind: "apiKey", id: k.id, name: k.name, active: k.isActive,
          description: [k.key, k.scopes.length ? k.scopes.join(", ") : "", k.isActive ? "" : vscode.l10n.t("disabled")].filter(Boolean).join(" · "),
        }));
      case "mcp": {
        const m = s.mcp;
        if (!m) return [{ kind: "info", label: vscode.l10n.t("Status unavailable"), icon: "question" }];
        const out: Node[] = [
          { kind: "info", label: m.enabled ? (m.online ? vscode.l10n.t("Online") : vscode.l10n.t("Enabled, not running")) : vscode.l10n.t("Disabled on the server"), description: m.transport, icon: m.online ? "pass" : "circle-slash" },
        ];
        if (m.calls24h !== undefined)
          out.push({ kind: "info", label: vscode.l10n.t("{0} tool calls in 24h", m.calls24h), description: m.successRate !== undefined ? vscode.l10n.t("{0}% ok", Math.round(m.successRate * 100)) : undefined, icon: "pulse" });
        if (m.enabled && m.transport && m.transport !== "streamable-http")
          out.push({ kind: "info", label: vscode.l10n.t("VS Code needs the streamable-http transport"), description: vscode.l10n.t("change it in OmniRoute settings"), icon: "warning" });
        return out;
      }
      case "recent":
        return s.routing.slice(0, 15).map((r) => ({
          kind: "info",
          label: r.requested,
          description: r.ok ? describeRouting(r) || (r.served ?? "") : vscode.l10n.t("failed"),
          icon: r.ok ? (r.fallbackAttempts ? "debug-step-over" : "arrow-right") : "error",
          tooltip: [r.decision, r.error, r.correlationId && `correlation ${r.correlationId}`, new Date(r.at).toLocaleTimeString()].filter(Boolean).join("\n"),
        }));
      default:
        return [];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const s = this.s;
    switch (node.kind) {
      case "server": {
        const item = new vscode.TreeItem(vscode.l10n.t("OmniRoute"), vscode.TreeItemCollapsibleState.Collapsed);
        const healthy = !s.health || /ok|healthy/i.test(s.health.status);
        item.description = [s.version?.current ? `v${s.version.current}` : "", healthy ? vscode.l10n.t("healthy") : s.health?.status].filter(Boolean).join(" · ");
        item.iconPath = new vscode.ThemeIcon(healthy ? "pass-filled" : "warning", new vscode.ThemeColor(healthy ? "testing.iconPassed" : "editorWarning.foreground"));
        item.contextValue = "server.online";
        item.tooltip = s.baseUrl;
        return item;
      }
      case "serverInfo": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        return item;
      }
      case "signIn": {
        const item = new vscode.TreeItem(vscode.l10n.t("Sign in to manage the gateway"));
        item.description = vscode.l10n.t("combos, providers, analytics");
        item.iconPath = new vscode.ThemeIcon("sign-in");
        item.command = { command: "omniroute.signIn", title: vscode.l10n.t("Sign In") };
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(node.label, node.id === "copilot" || node.id === "combos" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `group:${node.id}`;
        item.description = node.count !== undefined ? String(node.count) : undefined;
        item.iconPath = new vscode.ThemeIcon(
          { copilot: "copilot", combos: "git-merge", connections: "plug", catalog: "library", keys: "key", mcp: "tools", recent: "history" }[node.id]
        );
        item.contextValue = `group.${node.id}`;
        return item;
      }
      case "provider": {
        const item = new vscode.TreeItem(node.provider, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `provider:${node.provider}`;
        const picked = node.models.filter((m) => this._store.isPicked(m.id)).length;
        item.description = picked ? vscode.l10n.t("{0} models · {1} in Copilot", node.models.length, picked) : vscode.l10n.t("{0} models", node.models.length);
        item.iconPath = new vscode.ThemeIcon("server");
        return item;
      }
      case "model": {
        const m = node.model;
        const item = new vscode.TreeItem(m.kind === "model" ? m.id : m.name === m.id ? m.id : `${m.name}`);
        item.id = `${node.inCopilotGroup ? "copilot" : "catalog"}:${m.id}`;
        const bits = [m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : "", m.toolCalling ? vscode.l10n.t("tools") : "", m.vision ? vscode.l10n.t("vision") : "", m.reasoning ? vscode.l10n.t("reasoning") : ""].filter(Boolean);
        item.description = m.kind === "auto" ? vscode.l10n.t("auto-routing") : m.kind === "combo" ? vscode.l10n.t("combo") : bits.join(" · ");
        item.tooltip = new vscode.MarkdownString(`**${m.id}**${m.description ? `\n\n${m.description}` : ""}\n\n${bits.join(" · ")}`);
        item.iconPath = new vscode.ThemeIcon(m.kind === "auto" ? "sparkle" : m.kind === "combo" ? "git-merge" : "symbol-class");
        item.contextValue = m.kind === "model" ? "model" : "copilotEntry";
        if (m.kind === "model" && !node.inCopilotGroup) {
          item.checkboxState = this._store.isPicked(m.id) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        }
        return item;
      }
      case "combo": {
        const c = node.combo;
        const item = new vscode.TreeItem(c.name, c.models.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `combo:${c.id}`;
        item.description = [c.strategy, c.models.length ? vscode.l10n.t("{0} steps", c.models.length) : "", c.isActive ? "" : vscode.l10n.t("disabled")].filter(Boolean).join(" · ");
        item.tooltip = new vscode.MarkdownString(`**${c.name}**${c.description ? `\n\n${c.description}` : ""}\n\n${c.models.map((st, i) => `${i + 1}. ${st.model ?? st.comboName}`).join("\n\n")}`);
        item.iconPath = new vscode.ThemeIcon("git-merge", c.isActive ? undefined : new vscode.ThemeColor("disabledForeground"));
        item.contextValue = c.isActive ? "combo.active" : "combo.inactive";
        return item;
      }
      case "step": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case "connection": {
        const c = node.connection;
        const item = new vscode.TreeItem(c.name);
        item.id = `connection:${c.id}`;
        const limited = c.rateLimitedUntil && Date.parse(c.rateLimitedUntil) > Date.now();
        const bad = c.testStatus === "error" || c.testStatus === "expired" || !!c.lastError;
        item.description = [c.provider, c.authType === "oauth" ? "OAuth" : "", !c.isActive ? vscode.l10n.t("disabled") : limited ? vscode.l10n.t("rate-limited") : bad ? vscode.l10n.t("error") : ""].filter(Boolean).join(" · ");
        item.tooltip = new vscode.MarkdownString(
          [`**${c.name}** (${c.provider})`, c.email, c.lastError ? `⚠ ${c.lastError}` : "", c.lastTested ? vscode.l10n.t("Last tested {0}", new Date(c.lastTested).toLocaleString()) : ""].filter(Boolean).join("\n\n")
        );
        item.iconPath = !c.isActive
          ? new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"))
          : bad
            ? new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"))
            : limited
              ? new vscode.ThemeIcon("watch", new vscode.ThemeColor("editorWarning.foreground"))
              : new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
        item.contextValue = c.isActive ? "connection.active" : "connection.inactive";
        return item;
      }
      case "apiKey": {
        const item = new vscode.TreeItem(node.name);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon("key", node.active ? undefined : new vscode.ThemeColor("disabledForeground"));
        item.contextValue = "apiKey";
        return item;
      }
      case "info": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
    }
  }

  dispose() {
    this._sub.dispose();
    this._onDidChange.dispose();
  }
}
