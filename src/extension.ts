import * as vscode from "vscode";
import { Actions } from "./actions";
import { AuthStore } from "./auth";
import { OmniChatProvider } from "./chatProvider";
import { OmniClient } from "./client";
import { DashboardPanel } from "./dashboardPanel";
import { OmniMcpProvider } from "./mcp";
import type { DashboardTab } from "./protocol";
import { ServerManager } from "./server";
import { StatusBar } from "./statusBar";
import { Store } from "./store";
import { type Node, OmniTree } from "./tree";

/** Exports for integration tests only — empty outside test mode so other extensions can't reach credentials. */
export interface ExtensionApi {
  test?: { store: Store; setApiKey(key: string | undefined): Promise<void>; setManagementKey(key: string | undefined): Promise<void> };
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const log = vscode.window.createOutputChannel("OmniRoute", { log: true });
  const auth = new AuthStore(context.secrets);
  const cfg = () => vscode.workspace.getConfiguration("omniroute");
  const client = new OmniClient({
    baseUrl: () => cfg().get<string>("baseUrl", "http://localhost:20128"),
    timeoutMs: () => cfg().get<number>("requestTimeoutSeconds", 15) * 1000,
    credentials: auth,
    userAgent: `omniroute-gateway-control/${context.extension.packageJSON.version} vscode/${vscode.version}`,
  });
  const store = new Store(client, auth, log);
  const server = new ServerManager(client, log);
  const actions = new Actions(store, auth, server, log);
  const tree = new OmniTree(store);
  const view = vscode.window.createTreeView("omniroute.explorer", { treeDataProvider: tree, showCollapseAll: true, manageCheckboxStateManually: true });
  const chat = new OmniChatProvider(store, log);
  const mcp = new OmniMcpProvider(store, auth);

  context.subscriptions.push(log, auth, store, server, tree, view, chat, mcp, new StatusBar(store));
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("omniroute", chat));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider("omniroute.mcp", mcp));

  view.onDidChangeCheckboxState(async (e) => {
    const on: string[] = [];
    const off: string[] = [];
    for (const [node, state] of e.items) if (node.kind === "model") (state === vscode.TreeItemCheckboxState.Checked ? on : off).push(node.model.id);
    if (on.length) await actions.setPicked(on, true);
    if (off.length) await actions.setPicked(off, false);
  });
  store.onDidChange((s) => {
    view.message = s.state === "online" && s.error && !s.models.length ? s.error : undefined;
    view.badge = s.health?.openBreakers.length ? { value: s.health.openBreakers.length, tooltip: vscode.l10n.t("Open circuit breakers") } : undefined;
  });

  const showDashboard = (tab?: DashboardTab) => DashboardPanel.show(context.extensionUri, store, actions, server, tab);
  const register = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`omniroute.${id}`, fn));
  const nodeModel = (n?: Node | string) => (typeof n === "string" ? n : n?.kind === "model" ? n.model.id : n?.kind === "combo" ? n.combo.name : undefined);

  register("openDashboard", (tab?: DashboardTab) => showDashboard(typeof tab === "string" ? tab : undefined));
  register("openWebDashboard", () => actions.openWeb());
  register("refresh", () => store.refresh());
  register("startServer", () => actions.startServer());
  register("stopServer", () => actions.stopServer());
  register("restartServer", () => actions.restartServer());
  register("showServerTerminal", () => server.showTerminal());
  register("signIn", () => actions.signIn());
  register("signOut", () => actions.signOut());
  register("setApiKey", () => actions.setApiKey());
  register("setManagementKey", () => actions.setManagementKey());
  register("createApiKey", () => actions.createApiKey());
  register("selectModels", () => actions.selectModels());
  register("toggleCopilotModel", (n?: Node | string) => {
    const id = nodeModel(n);
    if (id) return actions.setPicked([id], !store.isPicked(id));
  });
  register("copyBaseUrl", () => actions.copyBaseUrl());
  register("copyModelId", async (n?: Node | string) => {
    const id = nodeModel(n);
    if (id) await vscode.env.clipboard.writeText(id);
  });
  register("configureCli", () => actions.configureCli());
  register("runCli", () => actions.runCli());
  register("createCombo", () => actions.createCombo());
  register("deleteCombo", (n?: Node) => n?.kind === "combo" && actions.deleteCombo(n.combo.id, n.combo.name));
  register("toggleCombo", (n?: Node) => n?.kind === "combo" && actions.toggleCombo(n.combo.id));
  register("testProvider", (n?: Node) => n?.kind === "connection" && actions.testConnection(n.connection.id));
  register("toggleProvider", (n?: Node) => n?.kind === "connection" && actions.toggleConnection(n.connection.id));
  register("deleteApiKey", (n?: Node) => n?.kind === "apiKey" && actions.deleteApiKey(n.id, n.name));
  register("clearCache", () => actions.clearCache());
  register("resetBreakers", () => actions.resetBreakers());
  register("clearCooldowns", () => actions.clearCooldowns());
  register("setCompression", () => actions.setCompression());
  register("showLastRouting", () => actions.showLastRouting());
  register("showLogs", () => log.show());

  store.start();
  // Never block activation on the network; auto-start only if asked and nothing answers.
  if (cfg().get<boolean>("server.autoStart", false)) {
    void client.ping().then((up) => {
      if (!up) void actions.startServer();
    });
  }
  if (context.extensionMode !== vscode.ExtensionMode.Test) return {};
  return { test: { store, setApiKey: (k) => auth.setApiKey(k), setManagementKey: (k) => auth.setManagementKey(k) } };
}

export function deactivate() {}
