# Changelog

## Unreleased

Provider quota.

- **Providers page** shows each connection's upstream quota windows (session, weekly, credit balance, per-model…) with usage, remaining headroom and reset time, read from `GET /api/usage/provider-limits`.
- Bars show **usable** headroom, not the raw upstream percentage: OmniRoute reserves a cutoff margin and stops routing to a connection at or below it, so a bar reads 0% exactly when routing stops. The raw value is in the tooltip. Thresholds come from the gateway's `resilience.quotaPreflight` settings.
- Windows with no cap (a credit balance) render as unlimited rather than exhausted, and a provider that cannot report quota says so instead of showing empty bars.

Dashboard redesign.

- **Navigation:** Settings and the web dashboard link now sit in the sidebar footer. A gateway status card shows Healthy, Degraded, Needs API key or Offline, plus the host and version. When the sidebar collapses, a status dot appears on the logo. Counts and spend are hidden while the gateway isn't reachable.
- **Page header:** shows when the data was last refreshed. The primary button appears only where it fits the page (New combo, Add provider, Start OmniRoute, Set API key).
- **Overview:**
  - KPI tiles have icons.
  - A single Health card lists items to act on by severity, or shows "All clear".
  - The activity chart has a y-scale, gridlines and dates, and shows a bar's numbers when you hover over it.
- **Models:** capability icons are colour-coded. Catalog models show their provider's avatar. The checkbox column is labelled "Copilot".
- **Combos:** members are drawn as a fallback chain, marked primary and fallback for the `priority` strategy.
- **Providers:** a health summary (healthy, failing, rate-limited, disabled). Failing connections are outlined.
- **Settings:** an "On this page" index on wide windows.
- The stylesheet was rewritten around spacing and type tokens, and unused rules were removed.

## 0.1.0

First release.

- **Copilot Chat models:** OmniRoute's `auto/*` models, enabled combos and chosen catalog models in Copilot Chat. Streaming, tool calls, image input and reasoning are supported.
- **Request controls:**
  - compression mode, cache bypass and opting out of memory, sent as headers on each request
  - a per-window session ID for sticky routing
  - a correlation ID used to look up routing details
- **Status bar:** the gateway's health, and how the last Copilot request was routed (provider, model, latency, cost, fallbacks).
- **MCP:** OmniRoute's MCP server (Streamable HTTP) is registered with VS Code.
- **Server control:** start (npx, global, Docker or a custom command), restart and stop. A server started from VS Code binds to localhost by default.
- **Sign-in:** sign in with the admin password, which also creates a VS Code API key. A management key works too. All credentials are kept in secret storage.
- **Dashboard pages:**
  - Overview: KPIs, items that need attention, daily requests, recent requests, top spend
  - Models
  - Combos: create with ordered steps, enable or disable, delete
  - Providers: test, enable or disable
  - Usage: by model and provider, auto-routing stats, recent calls
  - Settings
- **Sidebar:** gateway, the Copilot lineup, combos and their steps, connections, the model catalog with Copilot checkboxes, API keys, MCP, and recent requests.
- **CLI integration:** `omniroute run` and `omniroute configure`, with the API key passed through the environment.
