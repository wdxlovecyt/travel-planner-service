import { ZodError } from "zod";
import { callDeepSeek, streamDeepSeekText, type ModelMessage, type DeepSeekToolCall } from "./deepseek";
import { GUIDE_TOOL, runGuideSearchByPlace, type RoutePlanBatchResponse } from "./guidePlan";
import { WEATHER_TOOL, runWeatherToolCall } from "./weatherPlan";

export type SseWriter = (event: string, data: unknown) => void | Promise<void>;

function startHeartbeat(
  write: SseWriter,
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
    void write("ping", {
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

function buildModelMessages(userPrompt: string): ModelMessage[] {
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
): ModelMessage[] {
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

export async function runPlanStream(
  userPrompt: string,
  write: SseWriter,
) {
  await write("start", { message: "stream connected" });
  let currentStage = "thinking";
  const heartbeat = startHeartbeat(write, () => currentStage);

  try {
    await write("status", { stage: "thinking", message: "正在分析问题" });
    const completion = await callDeepSeek(buildModelMessages(userPrompt), [GUIDE_TOOL, WEATHER_TOOL]);
    const assistantMessage = completion.choices?.[0]?.message;
    const toolCalls = parseToolCalls(assistantMessage);

    if (toolCalls.length === 0) {
      const reply = assistantMessage?.content ?? "";
      if (reply) {
        await write("delta", { content: reply });
      }
      await write("result", { reply });
      await write("done", { ok: true });
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
            await write("status", { stage, message });
          },
          onResult: async (result) => {
            currentStage = "result";
            await write("result", result);
          },
        },
      });
    }

    if (weatherToolCall) {
      currentStage = "fetching_weather";
      await write("status", { stage: "fetching_weather", message: "正在获取天气数据" });
      weatherOutput = await runWeatherToolCall(
        JSON.parse(weatherToolCall.function?.arguments ?? "{}"),
      );
    }

    if (routePlan && !weatherToolCall) {
      await write("result", routePlan);
      await write("done", { ok: true });
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
    await write("status", { stage: "responding", message: "正在生成回复" });
    const reply = await streamDeepSeekText(
      buildToolFollowUpMessages(userPrompt, toolCalls, toolResults),
      async (delta) => {
        await write("delta", { content: delta });
      },
    );

    if (routePlan) {
      await write("result", {
        type: "plan_combo",
        reply,
        route_plan: routePlan,
      });
    } else {
      await write("result", { reply });
    }
    await write("done", { ok: true });
  } finally {
    clearInterval(heartbeat);
  }
}

export async function writePlanStreamError(write: SseWriter, error: unknown) {
  const message =
    error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join("; ")
      : error instanceof Error
        ? error.message
        : "Unknown error";
  await write("error", {
    error: message,
  });
  await write("done", { ok: false });
}
