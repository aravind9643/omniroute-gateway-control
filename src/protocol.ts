// Messages between DashboardPanel (extension host) and src/webview/dashboard.ts. Type-only.
import type { Snapshot } from "./types";

export type DashboardTab = "overview" | "models" | "combos" | "providers" | "usage" | "settings";

/** Extension settings the dashboard can edit (keys are relative to "omniroute."). */
export interface ExtSettings {
  "copilot.enabled": boolean;
  "copilot.includeAutoModels": boolean;
  "copilot.includeCombos": boolean;
  "copilot.models": string[];
  "chat.compression": string;
  "chat.bypassCache": boolean;
  "chat.disableMemory": boolean;
  "chat.showReasoning": boolean;
  "chat.routingNotice": string;
  "mcp.enabled": boolean;
  "server.launchMode": string;
  "server.localhostOnly": boolean;
  "server.autoStart": boolean;
}

export interface DashboardState {
  snap: Snapshot;
  settings: ExtSettings;
  /** Ids currently offered to Copilot (after applying the settings). */
  offered: string[];
  launchedHere: boolean;
}

export type SimpleAction =
  | "ready" | "refresh" | "startServer" | "stopServer" | "restartServer" | "showServerTerminal" | "signIn" | "signOut" | "setApiKey"
  | "setManagementKey" | "createApiKey" | "openWeb" | "clearCache" | "resetBreakers" | "clearCooldowns" | "runCli" | "configureCli"
  | "copyBaseUrl" | "openSettings" | "showLogs";

/** Host → webview. */
export type HostMessage =
  | { type: "state"; state: DashboardState }
  | { type: "focus"; tab: DashboardTab }
  | { type: "result"; ok: boolean; text: string };

/** Webview → host. */
export type WebviewMessage =
  | { type: SimpleAction }
  | { type: "setSetting"; key: keyof ExtSettings; value: unknown }
  | { type: "togglePicked"; ids: string[]; on: boolean }
  | { type: "createCombo"; name: string; strategy: string; models: string[]; description?: string }
  | { type: "toggleCombo"; id: string; active: boolean }
  | { type: "deleteCombo"; id: string; name: string }
  | { type: "testConnection"; id: string }
  | { type: "toggleConnection"; id: string; active: boolean }
  | { type: "deleteApiKey"; id: string; name: string }
  | { type: "setCompression"; enabled?: boolean; defaultMode?: string }
  | { type: "setServerSetting"; key: "mcpEnabled" | "semanticCacheEnabled" | "hideAutoCombos"; value: boolean };
