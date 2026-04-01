import { callDeepSeek, streamDeepSeekText, type ModelMessage } from "./deepseek";
import { getWeather } from "../tools/weather/weather";
import type { WeatherStreamCallbacks } from "./types";

export const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description:
      "Get 3-day weather by QWeather location ID. You should provide both city and location_id (e.g. Beijing => 101010100, Shanghai => 101020100).",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name for display, e.g. Beijing",
        },
        location_id: {
          type: "string",
          description: "QWeather location ID, e.g. 101010100",
        },
      },
      required: ["location_id"],
    },
  },
} as const;

export async function runWeatherToolCall(args: unknown) {
  const parsed = (args ?? {}) as { city?: unknown; location_id?: unknown };
  return getWeather({
    ...(typeof parsed.city === "string" ? { city: parsed.city } : {}),
    locationId: String(parsed.location_id ?? ""),
  });
}

export async function runWeatherResponse(userPrompt: string): Promise<string> {
  const tools = [WEATHER_TOOL];

  const initialCompletion = await callDeepSeek([{ role: "user", content: userPrompt }], tools);
  const assistantMessage = initialCompletion.choices?.[0]?.message;
  const toolCalls = assistantMessage?.tool_calls;

  if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
    return assistantMessage?.content ?? "";
  }

  const toolCall = toolCalls[0];
  if (toolCall.function?.name !== "get_weather") {
    return assistantMessage?.content ?? "";
  }

  const weather = await runWeatherToolCall(JSON.parse(toolCall.function.arguments ?? "{}"));

  const followUpMessages: ModelMessage[] = [
    { role: "user", content: userPrompt },
    {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    },
    {
      role: "tool",
      content: weather,
      tool_call_id: toolCall.id,
    },
  ];

  const toolCompletion = await callDeepSeek(followUpMessages);
  return toolCompletion.choices?.[0]?.message?.content ?? "";
}

export async function runWeatherResponseStream(
  userPrompt: string,
  callbacks: WeatherStreamCallbacks,
): Promise<string> {
  const tools = [WEATHER_TOOL];

  await callbacks.onStatus?.("thinking", "正在分析问题");
  const initialCompletion = await callDeepSeek([{ role: "user", content: userPrompt }], tools);
  const assistantMessage = initialCompletion.choices?.[0]?.message;
  const toolCalls = assistantMessage?.tool_calls;

  if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
    const reply = assistantMessage?.content ?? "";
    if (reply) {
      await callbacks.onDelta?.(reply);
    }
    return reply;
  }

  const toolCall = toolCalls[0];
  if (toolCall.function?.name !== "get_weather") {
    const reply = assistantMessage?.content ?? "";
    if (reply) {
      await callbacks.onDelta?.(reply);
    }
    return reply;
  }

  await callbacks.onStatus?.("fetching_weather", "正在获取天气数据");
  const weather = await runWeatherToolCall(JSON.parse(toolCall.function.arguments ?? "{}"));

  const followUpMessages: ModelMessage[] = [
    { role: "user", content: userPrompt },
    {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    },
    {
      role: "tool",
      content: weather,
      tool_call_id: toolCall.id,
    },
  ];

  await callbacks.onStatus?.("responding", "正在生成回复");
  return streamDeepSeekText(followUpMessages, async (delta) => {
    await callbacks.onDelta?.(delta);
  });
}
