export type GlmContentPart =
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

export type GlmMessage = {
  role: "system" | "user" | "assistant";
  content: string | GlmContentPart[];
};

export type GlmStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
  }>;
};

export type GlmCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};
