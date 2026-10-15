import * as vscode from "vscode";

const KEY_INFERENCE = "omniroute.apiKey";
const KEY_MANAGEMENT = "omniroute.managementKey";
const KEY_SESSION = "omniroute.sessionCookie";

/**
 * Credentials for OmniRoute, all kept in VS Code SecretStorage (never in settings.json):
 * - API key: Bearer key for the /v1 inference API (chat, models, MCP).
 * - Management key: a management-scoped key for /api/* (combos, providers, analytics…).
 * - Session cookie: the dashboard `auth_token` obtained by signing in with the admin password;
 *   the password itself is never stored.
 */
export class AuthStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _cache: { api?: string; mgmt?: string; session?: string } | undefined;
  private readonly _sub: vscode.Disposable;

  constructor(private readonly _secrets: vscode.SecretStorage) {
    this._sub = _secrets.onDidChange((e) => {
      if ([KEY_INFERENCE, KEY_MANAGEMENT, KEY_SESSION].includes(e.key)) {
        this._cache = undefined;
        this._onDidChange.fire();
      }
    });
  }

  private async _load() {
    if (!this._cache) {
      const [api, mgmt, session] = await Promise.all([
        this._secrets.get(KEY_INFERENCE),
        this._secrets.get(KEY_MANAGEMENT),
        this._secrets.get(KEY_SESSION),
      ]);
      this._cache = { api: api || undefined, mgmt: mgmt || undefined, session: session || undefined };
    }
    return this._cache;
  }

  async apiKey() {
    return (await this._load()).api;
  }
  async managementKey() {
    return (await this._load()).mgmt;
  }
  async sessionCookie() {
    return (await this._load()).session;
  }

  /** Headers for management routes: session cookie and/or management key, whichever we have. */
  async managementHeaders(): Promise<Record<string, string>> {
    const { mgmt, session, api } = await this._load();
    const h: Record<string, string> = {};
    if (session) h.Cookie = `auth_token=${session}`;
    // A management-scoped key works as a Bearer token; fall back to the API key (it may carry management scope).
    const bearer = mgmt || api;
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return h;
  }

  async status() {
    const { api, mgmt, session } = await this._load();
    return { hasApiKey: !!api, hasManagementKey: !!mgmt, signedIn: !!session };
  }

  async setApiKey(v: string | undefined) {
    await this._set(KEY_INFERENCE, v);
  }
  async setManagementKey(v: string | undefined) {
    await this._set(KEY_MANAGEMENT, v);
  }
  async setSessionCookie(v: string | undefined) {
    await this._set(KEY_SESSION, v);
  }

  async clearAll() {
    await Promise.all([KEY_INFERENCE, KEY_MANAGEMENT, KEY_SESSION].map((k) => this._secrets.delete(k)));
    this._cache = undefined;
    this._onDidChange.fire();
  }

  private async _set(key: string, v: string | undefined) {
    if (v) await this._secrets.store(key, v.trim());
    else await this._secrets.delete(key);
    this._cache = undefined;
    this._onDidChange.fire();
  }

  dispose() {
    this._sub.dispose();
    this._onDidChange.dispose();
  }
}
