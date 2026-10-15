import * as vscode from "vscode";
import { ApiError, OmniClient, isChatModel } from "./client";
import type { AuthStore } from "./auth";
import type { ConnState, OmniModel, RoutingRecord, Snapshot } from "./types";

export type { ConnState, RoutingRecord, Snapshot };

const MAX_ROUTING = 50;

export class Store implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Snapshot>();
  readonly onDidChange = this._onDidChange.event;
  private _snap: Snapshot;
  private _timer: NodeJS.Timeout | undefined;
  private _inflight: Promise<void> | undefined;
  private _queued = false;
  private readonly _subs: vscode.Disposable[] = [];
  /**
   * Owned by the Store, not by a snapshot: a refresh awaits a dozen requests before committing, and
   * a chat finishing in that window would otherwise be dropped when the new snapshot lands.
   */
  private _routing: RoutingRecord[] = [];

  constructor(readonly client: OmniClient, private readonly _auth: AuthStore, private readonly _log: vscode.LogOutputChannel) {
    this._snap = this._empty();
    this._subs.push(
      _auth.onDidChange(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("omniroute.baseUrl")) {
          this._snap = this._empty();
          void this.refresh();
        }
        if (e.affectsConfiguration("omniroute.pollIntervalSeconds")) this._schedule();
        if (e.affectsConfiguration("omniroute.copilot")) this._fire();
      })
    );
  }

  private _empty(): Snapshot {
    return {
      state: "offline", baseUrl: this.client.baseUrl, canManage: false, auth: { hasApiKey: false, hasManagementKey: false, signedIn: false },
      models: [], combos: [], connections: [], keys: [], cooldowns: [], recentCalls: [], routing: this._routing,
    };
  }

  get snapshot(): Snapshot {
    return this._snap;
  }

  start() {
    this._schedule();
    void this.refresh();
  }

  private _schedule() {
    if (this._timer) clearInterval(this._timer);
    const secs = vscode.workspace.getConfiguration("omniroute").get<number>("pollIntervalSeconds", 30);
    this._timer = setInterval(() => void this.refresh(), Math.max(5, secs) * 1000);
  }

  /** Refreshes everything; concurrent calls coalesce into at most one follow-up run. */
  refresh(): Promise<void> {
    if (this._inflight) {
      this._queued = true;
      return this._inflight;
    }
    this._inflight = this._refresh()
      .catch((err) => this._log.error("[store] refresh failed", err as Error))
      .finally(() => {
        this._inflight = undefined;
        if (this._queued) {
          this._queued = false;
          void this.refresh();
        }
      });
    return this._inflight;
  }

  private async _refresh() {
    const next: Snapshot = { ...this._empty(), auth: await this._auth.status() };
    if (!(await this.client.ping())) {
      next.error = `No response from ${this.client.baseUrl}`;
      return this._commit(next);
    }

    try {
      next.models = await this.client.listModels();
      next.state = "online";
    } catch (err) {
      next.state = err instanceof ApiError && err.isAuth ? "needsKey" : "online";
      next.error = (err as Error).message;
    }

    try {
      next.canManage = await this.client.canManage();
    } catch (err) {
      this._log.warn(`[store] management check failed: ${(err as Error).message}`);
    }
    if (next.canManage) {
      const settle = async <T>(label: string, p: Promise<T>): Promise<T | undefined> => {
        try {
          return await p;
        } catch (err) {
          this._log.debug(`[store] ${label}: ${(err as Error).message}`);
          return undefined;
        }
      };
      const c = this.client;
      const [health, version, combos, connections, keys, usage, autoRouting, mcp, cache, cooldowns, compression, recentCalls, quota, thresholds] =
        await Promise.all([
          settle("health", c.health()),
          settle("version", c.version()),
          settle("combos", c.combos()),
          settle("connections", c.connections()),
          settle("keys", c.apiKeys()),
          settle("usage", c.usage()),
          settle("auto-routing", c.autoRouting()),
          settle("mcp", c.mcpStatus()),
          settle("cache", c.cacheStats()),
          settle("cooldowns", c.cooldowns()),
          settle("compression", c.compression()),
          settle("call-logs", c.callLogs({ limit: 25 })),
          settle("provider-limits", c.providerLimits()),
          settle("quota-thresholds", c.quotaThresholds()),
        ]);
      Object.assign(next, {
        health, version, usage, autoRouting, mcp, cache, compression,
        combos: combos ?? [], connections: connections ?? [], keys: keys ?? [], cooldowns: cooldowns ?? [], recentCalls: recentCalls ?? [],
        quota: quota && { ...quota, ...(thresholds ?? {}) },
      });
    }
    // Without the management API, combos still show up in /v1/models (owned_by "combo").
    if (!next.combos.length) {
      next.combos = next.models
        .filter((m) => m.kind === "combo")
        .map((m) => ({ id: m.id, name: m.id, strategy: "", models: [], isActive: true, isHidden: false, description: m.description, contextLength: m.contextLength }));
    }
    this._commit(next);
  }

  private _commit(next: Snapshot) {
    next.refreshedAt = Date.now();
    // Re-read: a chat may have finished while this refresh was in flight.
    next.routing = this._routing;
    this._snap = next;
    void vscode.commands.executeCommand("setContext", "omniroute.state", next.state);
    void vscode.commands.executeCommand("setContext", "omniroute.canManage", next.canManage);
    this._fire();
  }

  private _fire() {
    this._onDidChange.fire(this._snap);
  }

  // ------------------------------------------------------------- copilot

  /** Models offered in the Copilot picker: auto/* + active combos + explicitly chosen catalog models. */
  copilotModels(): OmniModel[] {
    const cfg = vscode.workspace.getConfiguration("omniroute.copilot");
    if (!cfg.get<boolean>("enabled", true) || this._snap.state !== "online") return [];
    const picked = new Set(cfg.get<string[]>("models", []));
    const autos = cfg.get<boolean>("includeAutoModels", true);
    const combos = cfg.get<boolean>("includeCombos", true);
    return this._snap.models.filter(
      (m) => isChatModel(m) && (picked.has(m.id) || (m.kind === "auto" && autos) || (m.kind === "combo" && combos))
    );
  }

  isPicked(id: string) {
    return vscode.workspace.getConfiguration("omniroute.copilot").get<string[]>("models", []).includes(id);
  }

  async setPicked(ids: string[]) {
    await vscode.workspace.getConfiguration("omniroute.copilot").update("models", [...new Set(ids)], vscode.ConfigurationTarget.Global);
  }

  // ------------------------------------------------------------- routing

  /** Records a finished Copilot request; enriches it from the call log when management access is available. */
  recordRouting(rec: RoutingRecord) {
    this._routing = [rec, ...this._routing].slice(0, MAX_ROUTING);
    this._snap.routing = this._routing;
    this._fire();
    if (!rec.correlationId || (rec.provider && rec.costUsd !== undefined)) return;
    void this._enrich(rec);
  }

  /**
   * Fills a routing record in from the call log. The row is written as the stream finishes, so it
   * may not be queryable yet; retry a few times with backoff rather than giving up on the first miss.
   * `canManage` is re-checked per attempt because a refresh may still be settling it.
   */
  private async _enrich(rec: RoutingRecord, delays = [600, 1200, 2500, 5000]) {
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      if (!this._snap.canManage) continue;
      try {
        const [row] = await this.client.callLogs({ correlationId: rec.correlationId, limit: 1 });
        if (!row) continue;
        Object.assign(rec, {
          provider: rec.provider || row.provider,
          served: row.model || rec.served,
          account: row.account,
          comboName: row.comboName,
          latencyMs: rec.latencyMs ?? row.durationMs,
          tokensIn: rec.tokensIn ?? row.tokensIn,
          tokensOut: rec.tokensOut ?? row.tokensOut,
        });
        this._fire();
        return;
      } catch (err) {
        this._log.debug(`[store] call-log lookup failed: ${(err as Error).message}`);
      }
    }
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
    this._subs.forEach((s) => s.dispose());
    this._onDidChange.dispose();
  }
}
