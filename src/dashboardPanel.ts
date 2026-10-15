import * as vscode from "vscode";
import type { Actions } from "./actions";
import type { ServerManager } from "./server";
import type { Store } from "./store";
import type { DashboardState, DashboardTab, ExtSettings, HostMessage, WebviewMessage } from "./protocol";

const SETTING_KEYS: (keyof ExtSettings)[] = [
  "copilot.enabled", "copilot.includeAutoModels", "copilot.includeCombos", "copilot.models", "chat.compression", "chat.bypassCache",
  "chat.disableMemory", "chat.showReasoning", "chat.routingNotice", "mcp.enabled", "server.launchMode", "server.localhostOnly", "server.autoStart",
];

/** Simple webview actions map 1:1 onto contributed commands. */
const COMMAND_FOR: Record<string, string> = {
  refresh: "omniroute.refresh", startServer: "omniroute.startServer", stopServer: "omniroute.stopServer", restartServer: "omniroute.restartServer",
  showServerTerminal: "omniroute.showServerTerminal", signIn: "omniroute.signIn", signOut: "omniroute.signOut", setApiKey: "omniroute.setApiKey",
  setManagementKey: "omniroute.setManagementKey", createApiKey: "omniroute.createApiKey", openWeb: "omniroute.openWebDashboard",
  clearCache: "omniroute.clearCache", resetBreakers: "omniroute.resetBreakers", clearCooldowns: "omniroute.clearCooldowns",
  runCli: "omniroute.runCli", configureCli: "omniroute.configureCli", copyBaseUrl: "omniroute.copyBaseUrl", showLogs: "omniroute.showLogs",
};

/** Webview host. All UI lives in media/dashboard.{js,css}; this class serializes state and runs actions. */
export class DashboardPanel implements vscode.Disposable {
  private static _current: DashboardPanel | undefined;
  private readonly _subs: vscode.Disposable[] = [];
  private _ready = false;
  private _pendingTab?: DashboardTab;

  static show(extensionUri: vscode.Uri, store: Store, actions: Actions, server: ServerManager, tab?: DashboardTab) {
    if (DashboardPanel._current) {
      DashboardPanel._current._panel.reveal();
      if (tab) DashboardPanel._current._focus(tab);
      return;
    }
    const panel = vscode.window.createWebviewPanel("omnirouteDashboard", "OmniRoute", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.svg");
    DashboardPanel._current = new DashboardPanel(panel, extensionUri, store, actions, server, tab);
  }

  static get isOpen() {
    return !!DashboardPanel._current;
  }

  private constructor(
    private readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _store: Store,
    private readonly _actions: Actions,
    private readonly _server: ServerManager,
    tab?: DashboardTab
  ) {
    this._pendingTab = tab;
    this._panel.webview.html = this._html();
    this._subs.push(
      this._panel.onDidDispose(() => this.dispose()),
      this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) =>
        this._handle(msg).catch((err) => this._post({ type: "result", ok: false, text: (err as Error).message }))
      ),
      this._store.onDidChange(() => this._postState()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("omniroute") && this._postState())
    );
  }

  private _focus(tab: DashboardTab) {
    if (this._ready) this._post({ type: "focus", tab });
    else this._pendingTab = tab;
  }

  private _post(msg: HostMessage) {
    void this._panel.webview.postMessage(msg);
  }

  private _state(): DashboardState {
    const cfg = vscode.workspace.getConfiguration("omniroute");
    const settings = Object.fromEntries(SETTING_KEYS.map((k) => [k, cfg.get(k)])) as unknown as ExtSettings;
    return {
      snap: this._store.snapshot,
      settings,
      offered: this._store.copilotModels().map((m) => m.id),
      launchedHere: this._server.launchedHere,
    };
  }

  private _postState() {
    if (this._ready) this._post({ type: "state", state: this._state() });
  }

  private async _handle(msg: WebviewMessage) {
    const a = this._actions;
    const c = this._store.client;
    switch (msg.type) {
      case "ready":
        this._ready = true;
        this._postState();
        if (this._pendingTab) this._post({ type: "focus", tab: this._pendingTab });
        this._pendingTab = undefined;
        return;
      case "openSettings":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:AravindMerugu.omniroute-gateway-control");
      case "setSetting":
        if (!SETTING_KEYS.includes(msg.key)) return;
        await vscode.workspace.getConfiguration("omniroute").update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        return;
      case "togglePicked":
        return a.setPicked(msg.ids, msg.on);
      case "createCombo": {
        const r = await a.run("Creating the combo", () => c.createCombo(msg));
        this._post(r ? { type: "result", ok: true, text: `Created combo "${msg.name}"` } : { type: "result", ok: false, text: "Could not create the combo — see the notification" });
        return;
      }
      case "toggleCombo":
        await a.run("Updating the combo", () => c.updateCombo(msg.id, { isActive: msg.active }));
        return;
      case "deleteCombo":
        return a.deleteCombo(msg.id, msg.name);
      case "testConnection":
        await a.testConnection(msg.id);
        return;
      case "toggleConnection":
        return a.toggleConnection(msg.id, msg.active);
      case "deleteApiKey":
        return a.deleteApiKey(msg.id, msg.name);
      case "setCompression": {
        const patch: Record<string, unknown> = {};
        if (msg.enabled !== undefined) patch.enabled = msg.enabled;
        if (msg.defaultMode) patch.defaultMode = msg.defaultMode;
        await a.run("Updating compression", () => c.setCompression(patch));
        return;
      }
      case "setServerSetting":
        if (!["mcpEnabled", "semanticCacheEnabled", "hideAutoCombos"].includes(msg.key)) return;
        await a.run("Updating the gateway setting", () => c.patchSettings({ [msg.key]: msg.value }));
        return;
      default: {
        const cmd = COMMAND_FOR[msg.type];
        if (cmd) await vscode.commands.executeCommand(cmd);
      }
    }
  }

  private _html(): string {
    const webview = this._panel.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", f));
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join("");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${media("codicon.css")}">
  <link rel="stylesheet" href="${media("dashboard.css")}">
  <title>OmniRoute</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("dashboard.js")}"></script>
</body>
</html>`;
  }

  dispose() {
    DashboardPanel._current = undefined;
    this._subs.forEach((s) => s.dispose());
    this._panel.dispose();
  }
}
