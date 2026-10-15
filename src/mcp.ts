import * as vscode from "vscode";
import type { AuthStore } from "./auth";
import type { Store } from "./store";

/**
 * Offers OmniRoute's MCP server (Streamable HTTP at /api/mcp/stream) to VS Code's agent mode.
 * OmniRoute accepts a key with the "mcp:connect" or "manage" scope, or the dashboard session.
 */
export class OmniMcpProvider implements vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;
  private _signature = "";
  private readonly _sub: vscode.Disposable;

  constructor(private readonly _store: Store, private readonly _auth: AuthStore) {
    this._sub = _store.onDidChange((s) => {
      const sig = [this._enabled(), s.state, s.baseUrl, s.mcp?.enabled, s.mcp?.transport, s.auth.hasApiKey, s.auth.hasManagementKey, s.auth.signedIn].join("|");
      if (sig !== this._signature) {
        this._signature = sig;
        this._onDidChange.fire();
      }
    });
  }

  private _enabled() {
    return vscode.workspace.getConfiguration("omniroute.mcp").get<boolean>("enabled", true);
  }

  async provideMcpServerDefinitions(): Promise<vscode.McpHttpServerDefinition[]> {
    const s = this._store.snapshot;
    if (!this._enabled() || s.state === "offline") return [];
    // When we can see the server's MCP status, only offer it if it is enabled with the HTTP transport.
    if (s.mcp && (!s.mcp.enabled || (s.mcp.transport && s.mcp.transport !== "streamable-http"))) return [];
    const headers = await mcpHeaders(this._auth);
    if (!headers) return [];
    return [new vscode.McpHttpServerDefinition("OmniRoute", vscode.Uri.parse(`${this._store.client.baseUrl}/api/mcp/stream`), headers, s.version?.current)];
  }

  async resolveMcpServerDefinition(def: vscode.McpHttpServerDefinition): Promise<vscode.McpHttpServerDefinition> {
    // Keys may have changed since the definition was listed.
    const headers = await mcpHeaders(this._auth);
    if (headers) def.headers = headers;
    return def;
  }

  dispose() {
    this._sub.dispose();
    this._onDidChange.dispose();
  }
}

/** Prefers the management key (manage scope), then the API key (works if it has mcp:connect), then the session. */
export async function mcpHeaders(auth: Pick<AuthStore, "managementKey" | "apiKey" | "sessionCookie">): Promise<Record<string, string> | undefined> {
  const key = (await auth.managementKey()) || (await auth.apiKey());
  if (key) return { Authorization: `Bearer ${key}` };
  const session = await auth.sessionCookie();
  if (session) return { Cookie: `auth_token=${session}` };
  return undefined;
}
