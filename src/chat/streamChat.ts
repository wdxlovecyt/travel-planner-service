import type { ServerResponse } from "node:http";
import { callDeepSeek, streamDeepSeekText, type ChatMessage, type DeepSeekToolCall } from "./deepseek.js";
import { GUIDE_TOOL, runGuideSearchByPlace, type RoutePlanBatchResponse } from "./guideChat.js";
import { WEATHER_TOOL, runWeatherToolCall } from "./weatherChat.js";

function writeSse(
  res: ServerResponse,
  event: string,
  data: unknown,
) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function startHeartbeat(
  res: ServerResponse,
  getStage: () => string,
) {
  const stageMessages: Record<string, string> = {
    thinking: "正在分析你的问题",
    searching_guides: "正在检索攻略来源",
    extracting_places: "正在提取攻略中的地点与路线",
    extracting_candidate: "正在并发分析攻略内容",
    fetching_weather: "正在获取天气数据",
    responding: "正在生成最终回复",
    result: "正在整理结果",
  };
  const startedAt = Date.now();
  return setInterval(() => {
    const stage = getStage();
    writeSse(res, "ping", {
      stage,
      elapsed_seconds: Math.floor((Date.now() - startedAt) / 1000),
      message: stageMessages[stage] ?? "正在处理中",
    });
  }, 10_000);
}

function parseToolCalls(message: { tool_calls?: unknown } | undefined): DeepSeekToolCall[] {
  const rawToolCalls = message?.tool_calls;
  return Array.isArray(rawToolCalls) ? (rawToolCalls as DeepSeekToolCall[]) : [];
}

function buildChatMessages(userPrompt: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是旅行助手。你可以同时使用天气和攻略工具。不要由代码决定问题类型，而是由你根据用户意图决定是否调用 get_weather、search_travel_guide，必要时两个都调用。如果用户同时询问天气与游玩安排，你应综合使用两个工具。",
    },
    { role: "user", content: userPrompt },
  ];
}

function buildToolFollowUpMessages(
  userPrompt: string,
  toolCalls: DeepSeekToolCall[],
  toolResults: Array<{ toolCallId?: string; content: string }>,
): ChatMessage[] {
  return [
    { role: "user", content: userPrompt },
    {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    },
    ...toolResults.map((item) => ({
      role: "tool" as const,
      content: item.content,
      ...(item.toolCallId ? { tool_call_id: item.toolCallId } : {}),
    })),
  ];
}

export async function runChatStream(
  userPrompt: string,
  res: ServerResponse,
) {
  writeSse(res, "start", { message: "stream connected" });
  let currentStage = "thinking";
  const heartbeat = startHeartbeat(res, () => currentStage);

  try {
    writeSse(res, "status", { stage: "thinking", message: "正在分析问题" });
    const completion = await callDeepSeek(buildChatMessages(userPrompt), [GUIDE_TOOL, WEATHER_TOOL]);
    const assistantMessage = completion.choices?.[0]?.message;
    const toolCalls = parseToolCalls(assistantMessage);

    if (toolCalls.length === 0) {
      const reply = assistantMessage?.content ?? "";
      if (reply) {
        writeSse(res, "delta", { content: reply });
      }
      writeSse(res, "result", { reply });
      writeSse(res, "done", { ok: true });
      return;
    }

    const guideToolCall = toolCalls.find((call) => call.function?.name === "search_travel_guide");
    const weatherToolCall = toolCalls.find((call) => call.function?.name === "get_weather");

    let routePlan: RoutePlanBatchResponse | undefined;
    let weatherOutput = "";

    if (guideToolCall) {
      const args = JSON.parse(guideToolCall.function?.arguments ?? "{}") as { place_name?: unknown };
      const placeName = typeof args.place_name === "string" ? args.place_name.trim() : "";
      routePlan = await runGuideSearchByPlace({
        userPrompt,
        placeName,
        callbacks: {
          onStatus: async (stage, message) => {
            currentStage = stage;
            writeSse(res, "status", { stage, message });
          },
          onResult: async (result) => {
            currentStage = "result";
            writeSse(res, "result", result);
          },
        },
      });
    }

    if (weatherToolCall) {
      currentStage = "fetching_weather";
      writeSse(res, "status", { stage: "fetching_weather", message: "正在获取天气数据" });
      weatherOutput = await runWeatherToolCall(
        JSON.parse(weatherToolCall.function?.arguments ?? "{}"),
      );
    }

    if (routePlan && !weatherToolCall) {
      writeSse(res, "result", routePlan);
      writeSse(res, "done", { ok: true });
      return;
    }

    const toolResults: Array<{ toolCallId?: string; content: string }> = [];
    if (guideToolCall && routePlan) {
      toolResults.push({
        content: JSON.stringify(routePlan),
        ...(guideToolCall.id ? { toolCallId: guideToolCall.id } : {}),
      });
    }
    if (weatherToolCall && weatherOutput) {
      toolResults.push({
        content: weatherOutput,
        ...(weatherToolCall.id ? { toolCallId: weatherToolCall.id } : {}),
      });
    }

    currentStage = "responding";
    writeSse(res, "status", { stage: "responding", message: "正在生成回复" });
    const reply = await streamDeepSeekText(
      buildToolFollowUpMessages(userPrompt, toolCalls, toolResults),
      async (delta) => {
        writeSse(res, "delta", { content: delta });
      },
    );

    if (routePlan) {
      writeSse(res, "result", {
        type: "chat_combo",
        reply,
        route_plan: routePlan,
      });
    } else {
      writeSse(res, "result", { reply });
    }
    writeSse(res, "done", { ok: true });
  } finally {
    clearInterval(heartbeat);
  }
}

export function writeStreamError(res: ServerResponse, error: unknown) {
  writeSse(res, "error", {
    error: error instanceof Error ? error.message : "Unknown error",
  });
  writeSse(res, "done", { ok: false });
}
