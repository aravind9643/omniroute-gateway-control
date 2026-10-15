import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { errorMessage } from "./client";
import { REASONING_MARKER, countMessageChars, toOpenAIMessages } from "./messages";
import { StreamError, ThinkTagSplitter, parseRoutingHeaders, readChatStream, requestHeaders } from "./stream";
import type { Store } from "./store";
import type { OmniModel } from "./types";

type Progress = vscode.Progress<vscode.LanguageModelResponsePart>;

/** A user-facing error; its message is shown in the chat as is. */
class ChatError extends Error {}

const DEFAULT_OUTPUT = 16384;

/** Registers OmniRoute's auto/* models, combos and chosen catalog models with Copilot Chat. */
export class OmniChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private _signature = "";
  private readonly _sub: vscode.Disposable;
  /** One id per VS Code window, so OmniRoute can keep sticky routing and cache affinity for our requests. */
  private readonly _sessionId = `vscode-${randomUUID()}`;

  constructor(private readonly _store: Store, private readonly _log: vscode.LogOutputChannel) {
    this._sub = _store.onDidChange(() => {
      const sig = this._store.copilotModels().map((m) => `${m.id}:${m.contextLength}:${m.toolCalling}:${m.vision}`).join("|");
      if (sig !== this._signature) {
        this._signature = sig;
        this._onDidChange.fire();
      }
    });
  }

  async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
    const fallbackCtx = vscode.workspace.getConfiguration("omniroute.copilot").get<number>("contextWindow", 128000);
    return this._store.copilotModels().map((m) => toInfo(m, fallbackCtx));
  }

  async provideLanguageModelChatResponse(
    info: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: Progress,
    token: vscode.CancellationToken
  ): Promise<void> {
    const model = this._store.snapshot.models.find((m) => m.id === info.id);
    const cfg = vscode.workspace.getConfiguration("omniroute.chat");
    const showReasoning = cfg.get<boolean>("showReasoning", true);
    const mo = options.modelOptions || {};

    const body: Record<string, unknown> = {
      model: info.id,
      messages: toOpenAIMessages(messages, model?.vision !== false),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (typeof mo.temperature === "number") body.temperature = mo.temperature;
    if (typeof mo.topP === "number") body.top_p = mo.topP;
    if (typeof mo.maxTokens === "number") body.max_tokens = mo.maxTokens;
    if (options.tools?.length && model?.toolCalling !== false) {
      body.tools = options.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } } }));
      body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
    }

    const correlationId = randomUUID();
    const headers = requestHeaders(cfg, this._sessionId, correlationId);
    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());
    const started = Date.now();
    const out = new ReasoningWriter(progress, showReasoning);
    const think = new ThinkTagSplitter();
    const calls: vscode.LanguageModelToolCallPart[] = [];
    let res: Response | undefined;

    try {
      try {
        res = await this._store.client.chat(body, headers, abort.signal);
      } catch (err) {
        if (token.isCancellationRequested) return;
        throw new ChatError(`Could not reach OmniRoute at ${this._store.client.baseUrl}: ${describeNetError(err)}. Start it with "OmniRoute: Start Server".`);
      }
      if (!res.ok) {
        const msg = errorMessage(res.status, await res.text().catch(() => ""));
        const hint = res.status === 401 || res.status === 403 ? ' Set a valid key with "OmniRoute: Set API Key".' : "";
        throw new ChatError(`OmniRoute: ${msg}.${hint}`);
      }
      if (!res.body) throw new ChatError("OmniRoute returned an empty response.");
      const routing = parseRoutingHeaders(res.headers);
      const usage = await readChatStream(
        res.body,
        {
          text: (c) => {
            for (const seg of think.push(c)) seg.think ? out.reasoning(seg.text) : out.text(seg.text);
          },
          reasoning: (c) => out.reasoning(c),
          toolCall: (id, name, input) => calls.push(new vscode.LanguageModelToolCallPart(id, name, input)),
        },
        abort.signal
      );
      if (token.isCancellationRequested) return;
      for (const seg of think.flush()) seg.think ? out.reasoning(seg.text) : out.text(seg.text);
      out.end();
      // Tool calls after the text, so Copilot shows the explanation first.
      for (const call of calls) progress.report(call);

      this._store.recordRouting({
        ...routing,
        at: Date.now(),
        ok: true,
        requested: info.id,
        served: routing.model || usage.servedModel,
        durationMs: Date.now() - started,
        tokensIn: routing.tokensIn ?? usage.promptTokens,
        tokensOut: routing.tokensOut ?? usage.completionTokens,
        correlationId: res.headers.get("x-correlation-id") || correlationId,
      });
    } catch (err) {
      if (token.isCancellationRequested) return;
      const message = err instanceof ChatError ? err.message : err instanceof StreamError ? `OmniRoute: ${err.message}` : `OmniRoute request failed: ${(err as Error).message}`;
      this._log.warn(`[chat] ${info.id}: ${message}`);
      this._store.recordRouting({ at: Date.now(), ok: false, requested: info.id, error: message, correlationId, durationMs: Date.now() - started });
      throw new Error(message);
    } finally {
      cancelSub.dispose();
    }
  }

  async provideTokenCount(_info: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    const chars = typeof text === "string" ? text.length : countMessageChars(text);
    return Math.max(1, Math.ceil(chars / 4));
  }

  dispose() {
    this._sub.dispose();
    this._onDidChange.dispose();
  }
}

export function toInfo(m: OmniModel, fallbackCtx: number): vscode.LanguageModelChatInformation {
  const ctx = m.contextLength || fallbackCtx;
  const maxOut = Math.min(m.maxOutputTokens || DEFAULT_OUTPUT, Math.floor(ctx / 2));
  const maxIn = m.maxInputTokens && m.maxInputTokens < ctx ? m.maxInputTokens : ctx - maxOut;
  const detail = m.kind === "auto" ? "OmniRoute auto-routing" : m.kind === "combo" ? "OmniRoute combo" : `OmniRoute · ${m.ownedBy}`;
  return {
    id: m.id,
    name: m.kind === "model" ? m.name : m.name === m.id ? m.id : `${m.name} (${m.id})`,
    family: m.kind === "model" ? m.ownedBy : `omniroute-${m.kind}`,
    detail,
    tooltip: `${m.description ? m.description + "\n" : ""}${m.id} · ${Math.round(ctx / 1000)}k context${m.kind !== "model" ? " · routed by OmniRoute with automatic fallback" : ""}`,
    version: "1.0.0",
    maxInputTokens: maxIn,
    maxOutputTokens: maxOut,
    // auto/* and combos may land on any member, so assume tools unless OmniRoute says otherwise.
    capabilities: { toolCalling: m.toolCalling !== false, imageInput: m.vision === true },
  };
}

function describeNetError(err: unknown): string {
  const e = err as any;
  const code = e?.cause?.code || e?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND") return "host not found";
  if (e?.name === "TimeoutError") return "timed out";
  return e?.cause?.message || e?.message || String(err);
}

/** Renders reasoning as a quoted block ahead of the answer (no stable thinking part exists yet). */
class ReasoningWriter {
  private _inReasoning = false;
  constructor(private readonly _progress: Progress, private readonly _show: boolean) {}

  reasoning(chunk: string) {
    if (!this._show) return;
    if (!this._inReasoning) {
      this._inReasoning = true;
      this._progress.report(new vscode.LanguageModelTextPart(`${REASONING_MARKER}\n> `));
    }
    this._progress.report(new vscode.LanguageModelTextPart(chunk.replace(/\n/g, "\n> ")));
  }

  text(chunk: string) {
    if (this._inReasoning) {
      this._inReasoning = false;
      this._progress.report(new vscode.LanguageModelTextPart("\n\n"));
      chunk = chunk.replace(/^\n+/, "");
      if (!chunk) return;
    }
    this._progress.report(new vscode.LanguageModelTextPart(chunk));
  }

  end() {
    if (this._inReasoning) this._progress.report(new vscode.LanguageModelTextPart("\n\n"));
    this._inReasoning = false;
  }
}
