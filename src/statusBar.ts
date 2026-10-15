import * as vscode from "vscode";
import { describeRouting, formatUsd } from "./stream";
import type { Store } from "./store";

/** Two status bar entries: gateway health, and how the last Copilot request was routed. */
export class StatusBar implements vscode.Disposable {
  private readonly _server = vscode.window.createStatusBarItem("omniroute.server", vscode.StatusBarAlignment.Right, 100);
  private readonly _routing = vscode.window.createStatusBarItem("omniroute.routing", vscode.StatusBarAlignment.Right, 99);
  private readonly _subs: vscode.Disposable[] = [];

  constructor(private readonly _store: Store) {
    this._server.name = "OmniRoute";
    this._routing.name = vscode.l10n.t("OmniRoute last request");
    this._routing.command = "omniroute.showLastRouting";
    this._subs.push(
      _store.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("omniroute.chat.routingNotice") && this.update())
    );
    this.update();
  }

  update() {
    const s = this._store.snapshot;
    const srv = this._server;
    srv.backgroundColor = undefined;
    if (s.state === "offline") {
      srv.text = "$(circle-slash) OmniRoute";
      srv.tooltip = vscode.l10n.t("OmniRoute is not reachable at {0}. Click to start it.", s.baseUrl);
      srv.command = "omniroute.startServer";
    } else if (s.state === "needsKey") {
      srv.text = "$(key) OmniRoute";
      srv.tooltip = vscode.l10n.t("OmniRoute is running but rejected the API key. Click to set one.");
      srv.command = "omniroute.setApiKey";
      srv.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      const breakers = s.health?.openBreakers.length ?? 0;
      srv.text = `$(${breakers ? "warning" : "pass-filled"}) OmniRoute`;
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**OmniRoute** ${s.version?.current ? `v${s.version.current}` : ""} — ${s.baseUrl}\n\n`);
      md.appendMarkdown(`${vscode.l10n.t("{0} models in Copilot", this._store.copilotModels().length)}`);
      if (s.usage) md.appendMarkdown(` · ${vscode.l10n.t("{0} requests, {1} in 30 days", s.usage.totalRequests, formatUsd(s.usage.totalCost))}`);
      if (breakers) md.appendMarkdown(`\n\n$(warning) ${vscode.l10n.t("Open circuit breakers: {0}", s.health!.openBreakers.map((b) => b.provider).join(", "))}`);
      if (!s.canManage) md.appendMarkdown(`\n\n${vscode.l10n.t("Sign in to see analytics and manage combos.")}`);
      md.appendMarkdown(`\n\n[${vscode.l10n.t("Open dashboard")}](command:omniroute.openDashboard)`);
      srv.tooltip = md;
      srv.command = "omniroute.openDashboard";
      if (breakers) srv.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    srv.show();

    const last = s.routing[0];
    const enabled = vscode.workspace.getConfiguration("omniroute.chat").get<string>("routingNotice", "statusBar") === "statusBar";
    if (!enabled || !last) {
      this._routing.hide();
      return;
    }
    if (last.ok) {
      const summary = describeRouting(last) || last.served || last.requested;
      this._routing.text = `$(arrow-swap) ${truncate(summary, 60)}`;
      this._routing.tooltip = routingTooltip(last);
    } else {
      this._routing.text = `$(error) ${truncate(last.requested, 30)}`;
      this._routing.tooltip = last.error;
    }
    this._routing.show();
  }

  dispose() {
    this._subs.forEach((d) => d.dispose());
    this._server.dispose();
    this._routing.dispose();
  }
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function routingTooltip(r: import("./types").RoutingRecord): string {
  return [
    `${vscode.l10n.t("Requested")}: ${r.requested}`,
    r.served && `${vscode.l10n.t("Served by")}: ${r.served}${r.provider ? ` (${r.provider}${r.account ? `, ${r.account}` : ""})` : ""}`,
    r.comboName && `${vscode.l10n.t("Combo")}: ${r.comboName}`,
    r.decision && `${vscode.l10n.t("Decision")}: ${r.decision}`,
    r.latencyMs !== undefined && `${vscode.l10n.t("Latency")}: ${Math.round(r.latencyMs)}ms`,
    r.costUsd !== undefined && `${vscode.l10n.t("Cost")}: ${formatUsd(r.costUsd)}`,
    (r.tokensIn !== undefined || r.tokensOut !== undefined) && `${vscode.l10n.t("Tokens")}: ${r.tokensIn ?? "?"} in / ${r.tokensOut ?? "?"} out`,
    r.fallbackAttempts ? `${vscode.l10n.t("Fallbacks")}: ${r.fallbackAttempts}` : "",
    r.cache && `${vscode.l10n.t("Cache")}: ${r.cache}`,
  ]
    .filter(Boolean)
    .join("\n");
}
