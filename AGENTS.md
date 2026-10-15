# AGENTS.md: context for coding agents working on omniroute-gateway-control

`CLAUDE.md` imports this file. Start with **§6 State & handoff**.

## 1. What this is
**Gateway Control for OmniRoute** (`AravindMerugu.omniroute-gateway-control`) is a VS Code extension that acts as a client and control panel for the [OmniRoute](https://github.com/diegosouzapw/OmniRoute) AI gateway (default `http://localhost:20128`). It does **not** re-implement the gateway. It:
- registers OmniRoute's models with Copilot Chat through `vscode.lm.registerLanguageModelChatProvider`, under vendor `omniroute`;
- registers OmniRoute's MCP server through `vscode.lm.registerMcpServerDefinitionProvider`;
- starts and stops a local server;
- surfaces OmniRoute's management API in a sidebar tree and a webview dashboard.

**Positioning (important).** OmniRoute's own author publishes `diegosouzapw.omnicopilot` ("OmniRoute for GitHub Copilot Chat", ~32k installs), which overlaps heavily on the Copilot-models side and ships 42 locales. Our differentiator is the **management/control plane**: provider quota, combo CRUD, provider health, analytics, server lifecycle and per-request controls. Keep naming and docs clearly unaffiliated — never imply this is the official extension — and invest in management features rather than re-racing the model picker.

## 2. Layout
```
src/
  extension.ts      wiring only (commands, views, providers); test hooks exported only in ExtensionMode.Test
  client.ts         OmniClient: typed HTTP client + response normalizers (no vscode import; unit-tested)
  stream.ts         SSE parsing, X-OmniRoute-* header parsing, request headers, <think> splitter (no vscode)
  launch.ts         launch commands for npx/global/docker/custom (no vscode)
  types.ts          shared shapes incl. Snapshot/RoutingRecord (no vscode; imported by the webview)
  store.ts          Store: polling, ConnState (offline | needsKey | online), management data, routing records
  auth.ts           AuthStore: API key, management key, session cookie in SecretStorage
  chatProvider.ts   Copilot provider: message conversion, streaming, tools, reasoning, routing records
  mcp.ts            MCP definition (/api/mcp/stream) with Bearer key or session cookie
  server.ts         ServerManager: terminal-based start, /api/shutdown, /api/restart
  actions.ts        command implementations shared by palette, tree and dashboard
  tree.ts, statusBar.ts, dashboardPanel.ts, protocol.ts, webview/dashboard.ts
test/
  mockServer.js     stdlib-only OmniRoute stand-in (shapes from the real route handlers)
  unit.test.js, dashboard.test.js (jsdom), integration/extension.test.js, fixtures.js, visual/
```

## 3. OmniRoute API facts (checked against upstream source, 2026-10-13)
- **Auth:**
  - `/v1/*` uses a Bearer inference key.
  - `/api/*` management routes take the `auth_token` cookie (from `POST /api/auth/login {password}`) or a Bearer key with the **`manage`** scope. Inference keys are rejected there.
  - MCP (`/api/mcp/stream`) also accepts the `mcp:connect` scope. It returns 503 when `mcpEnabled` is false, and 400 unless the transport is `streamable-http`.
- **No auth needed:** `GET /api/health`. `/api/monitoring/health` answers without auth but returns only `{status, setupComplete}`.
- **`/v1/models`:**
  - `auto/*` and combos have `owned_by:"combo"`.
  - Capabilities live in `capabilities.tool_calling`, `vision` and `reasoning`.
  - Limits are `context_length`, `max_input_tokens` and `max_output_tokens`.
  - Non-chat models carry `type` (embedding, image…).
- **Envelopes differ by route:**
  - `{combos,total}`, `{connections,total}`, `{keys,total,allowKeyReveal}`
  - bare objects: combo, compression config
  - bare arrays: `/api/usage/call-logs`
  - errors: `{error:string}`, `{error:{message,details}}` or the OpenAI shape
  - Always go through the normalizers in `client.ts`.
- **Streamed chats may lack `X-OmniRoute-*` headers** because of an early-keepalive wrapper. We send our own `X-Correlation-Id` and enrich the record from `GET /api/usage/call-logs?correlationId=`. Per-model cost comes from `/api/usage/analytics` (`byModel[].cost`).
- **Provider quota** (`GET /api/usage/provider-limits`, verified against a real gateway 2026-10-15):
  - `{caches: Record<connectionId, entry>, intervalMinutes, lastAutoSyncAt}`. A `POST` forces a refresh against every upstream — never call it from a poll.
  - Entry: `{quotas, modelQuotas, plan, message, fetchedAt, source, bankedResetCredits?, billing?}`. `plan` is a string for most providers but an object for some, so only strings are shown.
  - Window keys are provider-defined and free-form: `"session (5h)"`, `"weekly (7d)"`, `"credit"`, `"balance"`, `"Total"`, `"Auto + Composer"`, `"API"`, and bare model ids. They reach the webview, so they must be escaped like model names.
  - Window: `{used, total, remaining, remainingPercentage, resetAt, unlimited, windowSeconds?, currency?, displayName?, isPercentageOnly?}`. `resetAt` is null for windows that never reset.
  - **`unlimited: true` comes with `total`/`remaining`/`remainingPercentage` of 0** — it must not render as exhausted.
  - `remainingPercentage` is RAW. OmniRoute stops routing at a cutoff (`resilience.quotaPreflight.defaultThresholdPercent`, default **2**; warn default **20**) from `GET /api/settings`. Use `effectiveRemaining()` in `client.ts` so 0% means routing has actually stopped; keep the raw value in the tooltip.
- **`X-OmniRoute-Compression` accepts only** `off`, `default`, `safe`, `allow-lossy`, `engine:<id>` or a combo name. Unknown values are silently ignored, never rejected. The legacy `lite`/`standard`/`aggressive`/`ultra`/`rtk`/`stacked` names are valid for the server-wide `/api/settings/compression` config but **not** for the per-request header — our `omniroute.chat.compression` setting still sends them, so they are discarded (see §6).
- **Combo and key mutations:**
  - `POST /api/combos` takes `{name, strategy, models:[{kind:"model", model}]}`. PATCH merges.
  - `POST /api/keys` is the only call that returns a plaintext key.
- **Server control:**
  - `POST /api/restart` only SIGTERMs, so a supervisor has to bring the server back.
  - The web dashboard sends `X-Frame-Options: DENY`, so it can't be embedded; open it externally.

## 4. Commands
```bash
npm test                  # typecheck (strict) + unit + dashboard tests
npm run test:integration  # real VS Code (downloads into .vscode-test/)
npm run screenshots       # look at test/visual/out after UI changes; --readme refreshes media/screenshots
npm run l10n:export       # after changing vscode.l10n.t strings
npm run install:insiders  # build a VSIX and sideload it into Insiders (--stable, --keep); F5 is better for iterating
npx vsce package --no-dependencies
```

## 5. Rules
1. Run `npm test` after every change. Run `npm run test:integration` when you touch activation, the manifest, the chat provider or the client. Look at the screenshots after UI changes.
2. **Webview:**
   - Render every dynamic value through `esc()`. Model, provider and combo names come from the server.
   - No inline handlers; use `data-action` with the delegated listeners.
   - Colours only from `var(--vscode-*)`.
3. Runtime strings use literal `vscode.l10n.t("…")` calls, never an alias. Manifest strings live in `package.nls.json`, which is generated together with `contributes` by a script; edit both consistently.
4. **Network:** every request needs a timeout or an abort signal. Chats use the caller's cancellation token. Never block activation on the network.
5. **Secrets:**
   - Credentials go only in SecretStorage, never in settings.json or on command lines (CLI launches pass the key through terminal env).
   - Never send secrets to the webview: `Snapshot.auth` holds booleans only.
   - `extension.ts` exports test hooks only in `ExtensionMode.Test`.
6. Don't use proposed APIs.

## 6. State & handoff
_2026-10-15_
- **Provider quota shipped.** `OmniClient.providerLimits()`/`quotaThresholds()` → `Snapshot.quota`, rendered as bars on the dashboard's Providers page. 17 unit + 11 dashboard + 7 integration tests pass; screenshots clean in all themes.
  - Shapes were read from a real gateway (`%APPDATA%\omniroute\storage.sqlite`, namespace `providerLimitsCache`) across 12 providers, not inferred — see §3.
  - Not yet surfaced: sidebar tree, overview alerts, status bar, model picker. `modelWindows` is parsed but not drawn.
- **Known bug, not yet fixed:** `omniroute.chat.compression` offers `lite`/`standard`/`aggressive`/`ultra`/`rtk`/`stacked`, but the per-request header ignores every one of them (§3). `rtk` should be `engine:rtk`; the others have no per-request equivalent. The integration test only asserts the header was *sent*, so it passes regardless. Fixing this means changing the setting enum in `package.json` + `package.nls.json` and `COMPRESSION_MODES` in `types.ts`.

_2026-10-14_
- **v0.1.0 is feature-complete.**
  - `npm test`: 15 unit + 10 dashboard tests pass.
  - `npm run test:integration`: 7 tests pass on VS Code 1.141.1.
  - Screenshots are clean in all themes at 1280px and 640px.
- **Dashboard redesign (2026-10-14):**
  - `media/dashboard.css` was rewritten around tokens (`--fs-*`, `--sp-*`, `--radius*`).
  - Overview attention items are `Alert` objects rendered as `.alert.sev-*` rows. Don't use bare `.warn`/`.ok` there: they are colour utility classes.
  - `status()` drives both the rail card and the brand dot.
  - The chart readout uses delegated `mouseover`/`mouseout`; the tooltip HTML lives in `data-tip`, already escaped.
- **Smoke-tested against a real OmniRoute** on this machine, unauthenticated paths only (health, 401 → needsKey, login error parsing).
- **Next:**
  - Test against a real gateway with credentials: combos CRUD, call-log enrichment, MCP tools in agent mode.
  - Check the `auto/*` ids OmniRoute actually lists (they are generated upstream).
  - Possible additions:
    - an editor for combo weights and config
    - per-key budgets (`/api/usage/budget`)
    - the provider catalog and OAuth flows (currently delegated to the web dashboard)
    - memory browser (`/api/memory`)
    - webhooks
