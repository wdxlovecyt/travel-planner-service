type GlmContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

type GlmMessage = {
  role: "system" | "user" | "assistant";
  content: string | GlmContentPart[];
};

type GlmStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
  }>;
};

type GlmCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

const glmApiKey = process.env.GLM_API_KEY ?? process.env.ZHIPU_API_KEY;
const glmBaseUrl = (process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4").replace(
  /\/+$/,
  "",
);
const glmVisionModel = process.env.GLM_VISION_MODEL ?? "glm-4.6v-flash";
const glmStreamTimeoutMs = Math.max(Number(process.env.GLM_STREAM_TIMEOUT_MS ?? 60_000), 1_000);

function extractDeltaText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

export async function streamGlmText(
  messages: GlmMessage[],
  onDelta: (delta: string) => void | Promise<void>,
) {
  if (!glmApiKey) {
    throw new Error("GLM_API_KEY or ZHIPU_API_KEY is missing");
  }

  const response = await fetch(`${glmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${glmApiKey}`,
    },
    signal: AbortSignal.timeout(glmStreamTimeoutMs),
    body: JSON.stringify({
      model: glmVisionModel,
      messages,
      thinking: {
        type: "disabled",
      },
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GLM API error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error("GLM stream response has no body");
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
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        const chunk = JSON.parse(payload) as GlmStreamChunk;
        const delta = extractDeltaText(chunk.choices?.[0]?.delta?.content);
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

export async function callGlmText(messages: GlmMessage[]) {
  if (!glmApiKey) {
    throw new Error("GLM_API_KEY or ZHIPU_API_KEY is missing");
  }

  const response = await fetch(`${glmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${glmApiKey}`,
    },
    signal: AbortSignal.timeout(glmStreamTimeoutMs),
    body: JSON.stringify({
      model: glmVisionModel,
      messages,
      thinking: {
        type: "disabled",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GLM API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as GlmCompletionResponse;
  return extractDeltaText(data.choices?.[0]?.message?.content);
}

export type { GlmContentPart, GlmMessage };
