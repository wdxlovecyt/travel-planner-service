import { callDeepSeek, type ChatMessage, type DeepSeekToolCall } from "./deepseek.js";
import {
  GUIDE_TOOL,
  runGuideSearchByPlace,
} from "./guideChat.js";
import { WEATHER_TOOL, runWeatherToolCall } from "./weatherChat.js";
import type { ChatResult, RoutePlanBatchResponse } from "./types.js";

const CHAT_TOOLS = [GUIDE_TOOL, WEATHER_TOOL];

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

export async function runChat(userPrompt: string): Promise<ChatResult> {
  const completion = await callDeepSeek(buildChatMessages(userPrompt), CHAT_TOOLS);
  const assistantMessage = completion.choices?.[0]?.message;
  const toolCalls = parseToolCalls(assistantMessage);

  if (toolCalls.length === 0) {
    return assistantMessage?.content ?? "";
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
    });
  }

  if (weatherToolCall) {
    weatherOutput = await runWeatherToolCall(
      JSON.parse(weatherToolCall.function?.arguments ?? "{}"),
    );
  }

  if (routePlan && !weatherToolCall) {
    return routePlan;
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

  const followUp = await callDeepSeek(
    buildToolFollowUpMessages(userPrompt, toolCalls, toolResults),
  );
  const reply = followUp.choices?.[0]?.message?.content ?? "";

  if (routePlan) {
    return {
      type: "chat_combo",
      reply,
      route_plan: routePlan,
    };
  }

  return reply;
}
