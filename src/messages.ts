import * as vscode from "vscode";

export const REASONING_MARKER = "> 💭 *Thinking…*";
/** `LanguageModelChatMessageRole.System` exists at runtime but not in the stable typings. */
const ROLE_SYSTEM = 3;
const IMAGE_CHAR_ESTIMATE = 3000;

export function countMessageChars(msg: vscode.LanguageModelChatRequestMessage): number {
  let chars = 0;
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) chars += part.value.length;
    else if (part instanceof vscode.LanguageModelToolCallPart) chars += JSON.stringify(part.input ?? {}).length + part.name.length;
    else if (part instanceof vscode.LanguageModelToolResultPart) chars += toolResultText(part).length;
    else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) chars += IMAGE_CHAR_ESTIMATE;
  }
  return chars;
}

/** Converts Copilot's messages to OpenAI chat-completions messages (OmniRoute translates to each upstream format). */
export function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], allowImages: boolean): any[] {
  const out: any[] = [];
  for (const msg of messages) {
    const role = (msg.role as number) === ROLE_SYSTEM ? "system" : msg.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
    let text = "";
    const images: any[] = [];
    const toolCalls: any[] = [];
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({ id: part.callId, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        // OpenAI requires tool results immediately after the assistant turn that requested them.
        out.push({ role: "tool", tool_call_id: part.callId, content: toolResultText(part) });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        // Copilot also sends non-image data parts (e.g. cache_control); only images are forwarded.
        if (allowImages && part.mimeType.startsWith("image/")) {
          images.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}` } });
        }
      }
    }
    if (role === "assistant") text = stripReasoning(text);
    if (toolCalls.length) out.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
    else if (images.length) out.push({ role, content: [...(text ? [{ type: "text", text }] : []), ...images] });
    else if (text) {
      const prev = out[out.length - 1];
      if (role === "system" && prev?.role === "system") prev.content += `\n\n${text}`;
      else out.push({ role, content: text });
    }
  }
  return out;
}

function toolResultText(part: vscode.LanguageModelToolResultPart): string {
  let s = "";
  for (const c of part.content) {
    if (c instanceof vscode.LanguageModelTextPart) s += c.value;
    else if (typeof c === "string") s += c;
    else if (c && typeof c === "object" && "value" in c) s += String((c as any).value);
  }
  return s;
}

/** Removes the rendered reasoning block from earlier assistant turns so it is not re-sent as context. */
export function stripReasoning(text: string): string {
  if (!text.includes(REASONING_MARKER)) return text;
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(REASONING_MARKER)) {
      skipping = true;
      continue;
    }
    if (skipping && line.startsWith(">")) continue;
    skipping = false;
    kept.push(line);
  }
  return kept.join("\n").replace(/^\s+/, "");
}
