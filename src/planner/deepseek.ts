import type { ModelMessage, DeepSeekToolCall } from "./types";

export type { ModelMessage, DeepSeekToolCall } from "./types";

type DeepSeekStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
    };
    finish_reason?: string | null;
  }>;
};

function getDeepSeekApiKey() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY environment variable not set");
  }
  return apiKey;
}

export async function callDeepSeek(messages: ModelMessage[], tools?: unknown) {
  const apiKey = getDeepSeekApiKey();
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      tools,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

export async function streamDeepSeekText(
  messages: ModelMessage[],
  onDelta: (delta: string) => void | Promise<void>,
) {
  const apiKey = getDeepSeekApiKey();
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${errorText}`);
  }
  if (!response.body) {
    throw new Error("DeepSeek stream response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf("\n\n");

      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        const chunk = JSON.parse(payload) as DeepSeekStreamChunk;
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (!delta) {
          continue;
        }

        fullText += delta;
        await onDelta(delta);
      }
    }

    if (done) {
      break;
    }
  }

  return fullText;
}
