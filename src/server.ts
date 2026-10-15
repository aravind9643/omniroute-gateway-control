import * as vscode from "vscode";
import type { OmniClient } from "./client";
import { DOCKER_CONTAINER, type LaunchMode, launchCommand } from "./launch";

/**
 * Starts, stops and watches a local OmniRoute server. The server runs in a visible terminal so the
 * user sees its logs and first-run output; nothing is started without an explicit command or the
 * `omniroute.server.autoStart` setting.
 */
export class ServerManager implements vscode.Disposable {
  private _terminal: vscode.Terminal | undefined;
  private readonly _subs: vscode.Disposable[] = [];

  constructor(private readonly _client: OmniClient, private readonly _log: vscode.LogOutputChannel) {
    this._subs.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this._terminal) this._terminal = undefined;
      })
    );
  }

  get launchedHere() {
    return !!this._terminal;
  }

  private _cfg() {
    const c = vscode.workspace.getConfiguration("omniroute.server");
    return {
      mode: c.get<LaunchMode>("launchMode", "npx"),
      custom: c.get<string>("customCommand", ""),
      port: c.get<number>("port", 20128),
      dataDir: c.get<string>("dataDir", ""),
      localhostOnly: c.get<boolean>("localhostOnly", true),
    };
  }

  /** Starts the server unless it already answers, then waits until /api/health is ok. */
  async start(): Promise<boolean> {
    if (await this._client.ping()) {
      void vscode.window.showInformationMessage(vscode.l10n.t("OmniRoute is already running at {0}.", this._client.baseUrl));
      return true;
    }
    const cfg = this._cfg();
    const cmd = launchCommand(cfg.mode, cfg.port, cfg.custom, cfg.localhostOnly);
    if (!cmd) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Set omniroute.server.customCommand to the command that starts OmniRoute."));
      return false;
    }
    const env: Record<string, string> = { PORT: String(cfg.port) };
    if (cfg.localhostOnly) Object.assign(env, { HOST: "127.0.0.1", OMNIROUTE_SERVER_HOST: "127.0.0.1", API_HOST: "127.0.0.1" });
    if (cfg.dataDir) env.DATA_DIR = cfg.dataDir;

    this._terminal?.dispose();
    this._terminal = vscode.window.createTerminal({ name: "OmniRoute", env, iconPath: new vscode.ThemeIcon("server-process") });
    this._terminal.sendText(cmd);
    this._terminal.show(true);
    this._log.info(`[server] started: ${cmd}`);

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Starting OmniRoute…"), cancellable: true },
      async (_p, token) => {
        // First run downloads the package (npx) or image (docker), so allow a few minutes.
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline && !token.isCancellationRequested) {
          if (await this._client.ping()) {
            this._log.info("[server] healthy");
            return true;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!token.isCancellationRequested) {
          void vscode.window.showWarningMessage(vscode.l10n.t("OmniRoute did not become healthy. Check the OmniRoute terminal for errors."));
        }
        return false;
      }
    );
  }

  /** Asks the server to shut down; falls back to stopping the container or closing our terminal. */
  async stop(): Promise<void> {
    const cfg = this._cfg();
    let ok = false;
    try {
      await this._client.shutdown();
      ok = true;
    } catch (err) {
      this._log.warn(`[server] /api/shutdown failed: ${(err as Error).message}`);
    }
    if (!ok && cfg.mode === "docker") {
      const t = vscode.window.createTerminal({ name: "OmniRoute (stop)" });
      t.sendText(`docker stop ${DOCKER_CONTAINER}`);
      ok = true;
    }
    if (!ok && this._terminal) {
      this._terminal.dispose();
      this._terminal = undefined;
      ok = true;
    }
    if (!ok) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Could not stop OmniRoute: sign in with a management key, or stop it where it was started.")
      );
    }
  }

  async restart(): Promise<void> {
    try {
      await this._client.restart();
      void vscode.window.showInformationMessage(vscode.l10n.t("OmniRoute is restarting."));
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Restart failed: {0}", (err as Error).message));
    }
  }

  showTerminal() {
    if (this._terminal) this._terminal.show();
    else void vscode.window.showInformationMessage(vscode.l10n.t("OmniRoute was not started from this window."));
  }

  dispose() {
    this._subs.forEach((s) => s.dispose());
  }
}
