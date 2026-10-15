import * as vscode from "vscode";
import * as os from "os";
import { ApiError, isChatModel } from "./client";
import type { AuthStore } from "./auth";
import type { ServerManager } from "./server";
import type { Store } from "./store";
import { routingTooltip } from "./statusBar";
import { describeRouting } from "./stream";
import { COMBO_STRATEGIES, COMPRESSION_MODES, type OmniModel } from "./types";

/** CLIs that `omniroute run` can launch (README: claude, codex, aider, goose, opencode, qwen, gemini). */
export const RUN_CLIS = ["claude", "codex", "aider", "goose", "opencode", "qwen", "gemini"];
/** Targets for `omniroute configure`. */
export const CONFIGURE_TARGETS = ["claude", "codex", "cursor", "cline", "kilo", "continue", "opencode", "aider", "goose", "qwen", "gemini", "droid", "openclaw"];


export class Actions {
  constructor(
    private readonly _store: Store,
    private readonly _auth: AuthStore,
    private readonly _server: ServerManager,
    private readonly _log: vscode.LogOutputChannel
  ) {}

  private get client() {
    return this._store.client;
  }

  /** Runs a management call, reporting failures; refreshes state afterwards. Returns the result or undefined. */
  async run<T>(label: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> {
    try {
      const r = await fn();
      if (success) void vscode.window.showInformationMessage(typeof success === "function" ? success(r) : success);
      void this._store.refresh();
      return r;
    } catch (err) {
      this._log.warn(`[action] ${label}: ${(err as Error).message}`);
      if (err instanceof ApiError && err.isAuth) {
        void vscode.window.showErrorMessage(vscode.l10n.t("{0} needs management access. Sign in with the admin password or set a management key.", label), vscode.l10n.t("Sign In")).then((a) => {
          if (a) void vscode.commands.executeCommand("omniroute.signIn");
        });
      } else {
        void vscode.window.showErrorMessage(vscode.l10n.t("{0} failed: {1}", label, (err as Error).message));
      }
      return undefined;
    }
  }

  // --------------------------------------------------------------- auth

  async signIn() {
    const password = await vscode.window.showInputBox({
      title: vscode.l10n.t("Sign in to OmniRoute"),
      prompt: vscode.l10n.t("Admin password for {0}. Only the session token is stored (in VS Code secret storage).", this.client.baseUrl),
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;
    try {
      const cookie = await this.client.login(password);
      await this._auth.setSessionCookie(cookie);
      this._log.info("[auth] signed in");
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Sign-in failed: {0}", (err as Error).message));
      return;
    }
    if (!(await this._auth.apiKey())) {
      // Copilot traffic uses a normal API key; mint one so the user does not have to copy it over.
      const created = await this.run(vscode.l10n.t("Creating an API key"), () => this.client.createApiKey(`VS Code (${os.hostname()})`, ["mcp:connect"]));
      if (created) {
        await this._auth.setApiKey(created.key);
        void vscode.window.showInformationMessage(vscode.l10n.t("Signed in. Created API key \"VS Code ({0})\" for Copilot and MCP and stored it securely.", os.hostname()));
        return;
      }
    }
    void vscode.window.showInformationMessage(vscode.l10n.t("Signed in to OmniRoute."));
    void this._store.refresh();
  }

  async signOut() {
    const pick = await vscode.window.showWarningMessage(vscode.l10n.t("Sign out of OmniRoute and forget the stored API and management keys on this machine?"), { modal: true }, vscode.l10n.t("Sign Out"));
    if (!pick) return;
    await this.client.logout();
    await this._auth.clearAll();
  }

  async setApiKey() {
    const key = await vscode.window.showInputBox({
      title: vscode.l10n.t("OmniRoute API key"),
      prompt: vscode.l10n.t("Key for the /v1 API (copy it from Endpoints in the OmniRoute dashboard). Leave empty to remove it."),
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-…",
    });
    if (key === undefined) return;
    await this._auth.setApiKey(key || undefined);
  }

  async setManagementKey() {
    const key = await vscode.window.showInputBox({
      title: vscode.l10n.t("OmniRoute management key"),
      prompt: vscode.l10n.t("An API key with the \"manage\" scope, for combos, providers and analytics. Leave empty to remove it."),
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    await this._auth.setManagementKey(key || undefined);
  }

  async createApiKey() {
    const name = await vscode.window.showInputBox({ title: vscode.l10n.t("New OmniRoute API key"), prompt: vscode.l10n.t("Name"), value: `VS Code (${os.hostname()})`, ignoreFocusOut: true });
    if (!name) return;
    const created = await this.run(vscode.l10n.t("Creating an API key"), () => this.client.createApiKey(name, ["mcp:connect"]));
    if (!created) return;
    const use = vscode.l10n.t("Use in VS Code");
    const copy = vscode.l10n.t("Copy Key");
    const pick = await vscode.window.showInformationMessage(vscode.l10n.t("Created \"{0}\". This is the only time the full key is shown.", name), use, copy);
    if (pick === use) await this._auth.setApiKey(created.key);
    else if (pick === copy) await vscode.env.clipboard.writeText(created.key);
  }

  async deleteApiKey(id: string, name: string) {
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t("Revoke API key \"{0}\"? Clients using it stop working.", name), { modal: true }, vscode.l10n.t("Revoke"));
    if (ok) await this.run(vscode.l10n.t("Revoking the key"), () => this.client.deleteApiKey(id), vscode.l10n.t("Revoked \"{0}\".", name));
  }

  // ------------------------------------------------------------- models

  async selectModels() {
    const catalog = this._store.snapshot.models.filter((m) => m.kind === "model" && isChatModel(m));
    if (!catalog.length) {
      void vscode.window.showInformationMessage(this._store.snapshot.state === "online" ? vscode.l10n.t("OmniRoute lists no catalog models yet. Connect providers in the web dashboard.") : vscode.l10n.t("OmniRoute is not connected."));
      return;
    }
    const items = catalog
      .sort((a, b) => a.ownedBy.localeCompare(b.ownedBy) || a.id.localeCompare(b.id))
      .map((m) => ({ label: m.id, description: modelBits(m), picked: this._store.isPicked(m.id), id: m.id }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: vscode.l10n.t("Models to offer in Copilot Chat"),
      placeHolder: vscode.l10n.t("auto/* models and combos are offered automatically (see Settings)"),
      matchOnDescription: true,
    });
    if (chosen) await this._store.setPicked(chosen.map((c) => c.id));
  }

  async setPicked(ids: string[], on: boolean) {
    const cur = new Set(vscode.workspace.getConfiguration("omniroute.copilot").get<string[]>("models", []));
    for (const id of ids) on ? cur.add(id) : cur.delete(id);
    await this._store.setPicked([...cur]);
  }

  // ------------------------------------------------------------- combos

  async createCombo() {
    const name = await vscode.window.showInputBox({
      title: vscode.l10n.t("New combo (1/3)"),
      prompt: vscode.l10n.t("Name — this becomes the model id clients send, e.g. \"coding\""),
      validateInput: (v) => (!v ? undefined : /^[a-zA-Z0-9_./-]+$/.test(v) ? (this._store.snapshot.combos.some((c) => c.name === v) ? vscode.l10n.t("A combo with this name exists") : undefined) : vscode.l10n.t("Use letters, digits, - _ . /")),
      ignoreFocusOut: true,
    });
    if (!name) return;
    const strategy = await vscode.window.showQuickPick(
      COMBO_STRATEGIES.map((s) => ({ label: s, description: STRATEGY_HELP[s] })),
      { title: vscode.l10n.t("New combo (2/3) — routing strategy"), ignoreFocusOut: true }
    );
    if (!strategy) return;
    const models = await this._pickOrdered(vscode.l10n.t("New combo (3/3) — models, in fallback order"));
    if (!models?.length) return;
    await this.run(vscode.l10n.t("Creating the combo"), () => this.client.createCombo({ name, strategy: strategy.label, models }), vscode.l10n.t("Created combo \"{0}\" — it is now available as a model.", name));
  }

  /** Lets the user pick models one at a time so the order is the fallback order. */
  private async _pickOrdered(title: string): Promise<string[] | undefined> {
    const all = this._store.snapshot.models.filter(isChatModel);
    const picked: string[] = [];
    for (;;) {
      const done = { label: `$(check) ${vscode.l10n.t("Done")}`, description: picked.length ? picked.join(" → ") : vscode.l10n.t("pick at least one model"), id: "" };
      const items = [
        ...(picked.length ? [done] : []),
        ...all.filter((m) => !picked.includes(m.id)).map((m) => ({ label: m.id, description: modelBits(m), id: m.id })),
      ];
      const choice = await vscode.window.showQuickPick(items, { title: `${title}${picked.length ? ` — ${picked.length}` : ""}`, ignoreFocusOut: true, matchOnDescription: true });
      if (!choice) return picked.length ? picked : undefined;
      if (!choice.id) return picked;
      picked.push(choice.id);
    }
  }

  async toggleCombo(id: string) {
    const c = this._store.snapshot.combos.find((x) => x.id === id);
    if (!c) return;
    await this.run(vscode.l10n.t("Updating the combo"), () => this.client.updateCombo(id, { isActive: !c.isActive }));
  }

  async deleteCombo(id: string, name: string) {
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t("Delete combo \"{0}\"? Clients that use it as a model will get errors.", name), { modal: true }, vscode.l10n.t("Delete"));
    if (ok) await this.run(vscode.l10n.t("Deleting the combo"), () => this.client.deleteCombo(id), vscode.l10n.t("Deleted combo \"{0}\".", name));
  }

  // -------------------------------------------------------- connections

  async testConnection(id: string) {
    const c = this._store.snapshot.connections.find((x) => x.id === id);
    const label = c?.name ?? id;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Testing {0}…", label) }, () =>
      this.run(vscode.l10n.t("Testing the connection"), () => this.client.testConnection(id))
    );
    if (!r) return undefined;
    if (r.valid) void vscode.window.showInformationMessage(vscode.l10n.t("{0}: connection OK{1}", label, r.latencyMs ? ` (${r.latencyMs}ms)` : ""));
    else void vscode.window.showWarningMessage(vscode.l10n.t("{0}: {1}", label, r.error || vscode.l10n.t("connection failed")));
    return r;
  }

  async toggleConnection(id: string, active?: boolean) {
    const c = this._store.snapshot.connections.find((x) => x.id === id);
    if (!c) return;
    await this.run(vscode.l10n.t("Updating the connection"), () => this.client.setConnectionActive(id, active ?? !c.isActive));
  }

  // ---------------------------------------------------------- resilience

  async clearCache() {
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t("Clear OmniRoute's response cache?"), { modal: true }, vscode.l10n.t("Clear"));
    if (ok) await this.run(vscode.l10n.t("Clearing the cache"), () => this.client.clearCache(), vscode.l10n.t("Response cache cleared."));
  }

  async resetBreakers() {
    await this.run(vscode.l10n.t("Resetting circuit breakers"), () => this.client.resetBreakers(), (n) => (n !== undefined ? vscode.l10n.t("Reset {0} circuit breaker(s) and model lockouts.", n) : vscode.l10n.t("Circuit breakers reset.")));
  }

  async clearCooldowns() {
    await this.run(vscode.l10n.t("Clearing model cooldowns"), () => this.client.clearCooldowns(), vscode.l10n.t("Model cooldowns cleared."));
  }

  async setCompression() {
    const cur = this._store.snapshot.compression;
    const pick = await vscode.window.showQuickPick(
      [{ label: "off", description: vscode.l10n.t("disable compression") }, ...COMPRESSION_MODES.filter((m) => m !== "off").map((m) => ({ label: m, description: COMPRESSION_HELP[m] }))].map((i) => ({
        ...i,
        detail: cur && ((cur.enabled && cur.defaultMode === i.label) || (!cur.enabled && i.label === "off")) ? vscode.l10n.t("current") : undefined,
      })),
      { title: vscode.l10n.t("Server-wide default prompt compression") }
    );
    if (!pick) return;
    await this.run(
      vscode.l10n.t("Updating compression"),
      () => this.client.setCompression(pick.label === "off" ? { enabled: false } : { enabled: true, defaultMode: pick.label }),
      vscode.l10n.t("Compression set to {0}.", pick.label)
    );
  }

  // ---------------------------------------------------------------- CLI

  private _cliPrefix() {
    return vscode.workspace.getConfiguration("omniroute.server").get<string>("launchMode", "npx") === "global" ? "omniroute" : "npx -y omniroute";
  }

  async configureCli() {
    const target = await vscode.window.showQuickPick(CONFIGURE_TARGETS, { title: vscode.l10n.t("Point a tool at OmniRoute (omniroute configure)") });
    if (!target) return;
    const term = vscode.window.createTerminal({ name: `OmniRoute: configure ${target}`, env: { OMNIROUTE_BASE_URL: this.client.baseUrl } });
    term.sendText(`${this._cliPrefix()} configure ${target}`);
    term.show();
  }

  async runCli() {
    const cli = await vscode.window.showQuickPick(RUN_CLIS, { title: vscode.l10n.t("Run a CLI through OmniRoute (1/2)") });
    if (!cli) return;
    const models = this._store.snapshot.models.filter(isChatModel);
    const model = await vscode.window.showQuickPick(
      [...models.filter((m) => m.kind !== "model"), ...models.filter((m) => m.kind === "model")].map((m) => ({ label: m.id, description: m.kind === "model" ? modelBits(m) : m.kind })),
      { title: vscode.l10n.t("Run a CLI through OmniRoute (2/2) — model"), matchOnDescription: true }
    );
    if (!model) return;
    const key = await this._auth.apiKey();
    // The key travels in the terminal's environment, never on the command line or in shell history.
    const env: Record<string, string> = { OMNIROUTE_BASE_URL: this.client.baseUrl };
    if (key) env.OMNIROUTE_API_KEY = key;
    const term = vscode.window.createTerminal({ name: `OmniRoute: ${cli}`, env });
    term.sendText(`${this._cliPrefix()} run ${cli} --model ${shellQuote(model.label)}${key ? " --api-key-env OMNIROUTE_API_KEY" : ""}`);
    term.show();
  }

  // ------------------------------------------------------------- misc

  async copyBaseUrl() {
    await vscode.env.clipboard.writeText(this.client.openAiBaseUrl);
    void vscode.window.showInformationMessage(vscode.l10n.t("Copied {0}", this.client.openAiBaseUrl));
  }

  async openWeb() {
    await vscode.env.openExternal(vscode.Uri.parse(`${this.client.baseUrl}/dashboard`));
  }

  async showLastRouting() {
    const recs = this._store.snapshot.routing;
    if (!recs.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No Copilot requests through OmniRoute yet."));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      recs.map((r) => ({
        label: `${r.ok ? "$(arrow-swap)" : "$(error)"} ${r.requested}`,
        description: r.ok ? describeRouting(r) : r.error,
        detail: `${new Date(r.at).toLocaleTimeString()}${r.decision ? ` · ${r.decision}` : ""}`,
        rec: r,
      })),
      { title: vscode.l10n.t("Recent Copilot requests through OmniRoute"), matchOnDescription: true, matchOnDetail: true }
    );
    if (pick) void vscode.window.showInformationMessage(routingTooltip(pick.rec), { modal: true });
  }

  async startServer() {
    await this._server.start();
    void this._store.refresh();
  }

  async stopServer() {
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t("Stop the OmniRoute server at {0}? Every client using it loses access.", this.client.baseUrl), { modal: true }, vscode.l10n.t("Stop"));
    if (!ok) return;
    await this._server.stop();
    setTimeout(() => void this._store.refresh(), 1500);
  }

  async restartServer() {
    await this._server.restart();
    setTimeout(() => void this._store.refresh(), 3000);
  }
}

export function modelBits(m: OmniModel) {
  return [m.ownedBy, m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : "", m.toolCalling ? "tools" : "", m.vision ? "vision" : "", m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · ");
}

const shellQuote = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

export const STRATEGY_HELP: Record<string, string> = {
  priority: "Try models in order; fall back on failure",
  weighted: "Split traffic by weight",
  "round-robin": "Rotate through models evenly",
  "fill-first": "Use one model until its quota is used, then the next",
  p2c: "Power of two choices — pick the less loaded of two",
  random: "Pick at random",
  latency: "Prefer the fastest model",
  sticky: "Keep a session on the same model",
  "cost-optimized": "Prefer the cheapest model that can answer",
  fusion: "Combine answers from several models",
  "quota-share": "Pool quota across keys",
  "context-relay": "Hand long contexts to larger models",
};

export const COMPRESSION_HELP: Record<string, string> = {
  lite: "Light whitespace and boilerplate trimming",
  standard: "Balanced savings",
  aggressive: "Larger savings, some detail loss",
  ultra: "Maximum savings",
  rtk: "RTK engine — tool output and logs",
  stacked: "Run several engines in sequence",
};
