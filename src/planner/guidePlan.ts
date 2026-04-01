import {
  callDeepSeek,
  streamDeepSeekText,
} from "./deepseek";
import { streamGlmText, type GlmContentPart, type GlmMessage } from "./glm";
import {
  collectTravelGuideSearch,
  searchTravelGuideByPlace,
} from "../tools/travelGuideSearch/travelGuideSearch";
import type { GuideSearchResult } from "../tools/travelGuideSearch/types";
import type {
  ModelMessage,
  DeepSeekToolCall,
  DirectGuideInput,
  GuideExtractionInput,
  GuideProgressCallbacks,
  GuideRunOptions,
  LLMRoute,
  RouteExtractionStreamEvent,
  RoutePlanBatchResponse,
  RoutePlanResponse,
  RoutePlace,
  RouteSegment,
} from "./types";
export type {
  DirectGuideInput,
  GuideRunOptions,
  RoutePlanBatchResponse,
  RoutePlanResponse,
} from "./types";

export const GUIDE_TOOL = {
  type: "function",
  function: {
    name: "search_travel_guide",
    description:
      "Search travel guides from Zhihu and Mafengwo for one destination. This tool REQUIRES a pure geographic place_name only.",
    parameters: {
      type: "object",
      properties: {
        place_name: {
          type: "string",
          description:
            "Required place name for travel guide search. Must be only a geographic location such as city, district, street, or scenic area. Do not include weather, time, budget, or other constraints (e.g. 深圳, 南山区, 东门老街).",
        },
      },
      required: ["place_name"],
    },
  },
} as const;

const DEFAULT_GUIDE_SOURCE = "Bocha";

function toGuideSummary(snippet: string) {
  const clean = snippet.trim();
  if (!clean) {
    return "该笔记摘要信息较少，请打开来源链接查看完整攻略。";
  }
  return clean;
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/g, "").replace(/```$/g, "").trim(),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          // Keep trying the next candidate format.
        }
      }
    }
  }

  return null;
}

function buildGuideFailure(userPrompt: string, message: string): RoutePlanBatchResponse {
  return {
    type: "route_plan_batch",
    query: userPrompt,
    source: DEFAULT_GUIDE_SOURCE,
    strategy: "zhihu_mafengwo_only",
    overview: "攻略检索失败，未能生成路线。",
    metadata: {
      total_candidates: 0,
      route_count: 0,
      generated_at: new Date().toISOString(),
    },
    routes: [],
    note: `攻略来源检索失败：${message}`,
  };
}

function buildExtractionMessages(
  query: string,
  primaryLocation: string,
  candidate: GuideSearchResult,
): ModelMessage[] {
  return [
    {
      role: "system",
      content:
        "你是旅行规划助手。请判断这条候选内容是否真的是旅游攻略，并抽取其中真正提到的地名（城市/区/街道/景点/商圈/步行街等）。必须只输出 JSON，不要输出任何解释文本。",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          query,
          primary_location: primaryLocation,
          candidate: {
            title: (candidate.title ?? "").trim(),
            snippet: (candidate.snippet ?? "").trim().slice(0, 500),
            url: (candidate.url ?? "").trim(),
            siteName: (candidate.site_name ?? "").trim(),
            publishedAt: (candidate.published_at ?? "").trim(),
            sourceType: (candidate.source_type ?? "").trim(),
          },
          output: {
            route: {
              is_relevant_guide: true,
              places: [
                {
                  name: "地名",
                  evidence: "能支撑地名的简短摘录（可为空但不建议为空）",
                  day: 1,
                  advice: "该地点的游玩/拍照/购票/避坑建议，没有可为空",
                  next_segment_advice: "从该地点前往下一地点的路线或顺序建议，没有可为空",
                },
              ],
            },
            constraints: [
              "必须返回 route 对象",
              "route 必须包含 is_relevant_guide 字段；只有当候选内容确实是旅游攻略、游记、路线分享或行程建议时才设为 true",
              "如果候选内容是商品评测、广告软文、站点导航页、问答噪音页，或虽然来自目标站点但与旅游行程无关，is_relevant_guide 必须设为 false",
              "如果候选文本出现 Day1/Day2/Day3（或 第一天/第二天/第三天）等日程信息，必须尽量完整提取所有天的地点，不要只返回某一天",
              "每个 place 尽量包含 day 字段（数字，从 1 开始）",
              "places 必须按完整行程顺序排列，不要为了控制数量而省略中间地点",
              "如果文本里包含某个地点的相关建议，尽量写入该 place 的 advice 字段",
              "如果文本里包含从当前地点到下一地点的相关建议，尽量写入该 place 的 next_segment_advice 字段",
              "如果攻略中存在往返、回到酒店或重复经过同一地点，必须按原始行程顺序保留重复地名，不要自行去重",
              "如果无法抽取出明确地名，places 设为空数组",
              "如果 is_relevant_guide 为 false，places 必须设为空数组",
            ],
          },
        },
        null,
        0,
      ),
    },
  ];
}

function buildStreamingExtractionMessages(
  query: string,
  primaryLocation: string,
  candidate: GuideSearchResult,
): ModelMessage[] {
  return [
    {
      role: "system",
      content:
        "你是旅行规划助手。请边分析边输出 JSON Lines，每行一个 JSON 对象，不要输出 markdown 或解释。先尽快输出 meta，再每识别到一个地点就立刻输出一个 place，最后输出 done。允许的格式只有：{\"type\":\"meta\",\"is_relevant_guide\":true}, {\"type\":\"place\",\"name\":\"地名\",\"evidence\":\"证据\",\"day\":1,\"advice\":\"地点建议\",\"next_segment_advice\":\"去下一站的建议\"}, {\"type\":\"done\",\"is_relevant_guide\":true}。",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          query,
          primary_location: primaryLocation,
          candidate: {
            title: (candidate.title ?? "").trim(),
            snippet: (candidate.snippet ?? "").trim().slice(0, 500),
            url: (candidate.url ?? "").trim(),
            siteName: (candidate.site_name ?? "").trim(),
            publishedAt: (candidate.published_at ?? "").trim(),
            sourceType: (candidate.source_type ?? "").trim(),
          },
          constraints: [
            "必须先输出一行 meta",
            "如果是商品评测、广告软文、站点导航页、问答噪音页，meta 和 done 中的 is_relevant_guide 必须为 false，且不要输出 place",
            "如果出现 Day1/Day2/Day3（或 第一天/第二天/第三天）等日程信息，尽量完整提取所有天的地点",
            "places 必须按完整行程顺序输出",
            "如果存在往返、回酒店或重复经过同一地点，必须保留重复地名，不要去重",
            "如果文本里包含某个地点的相关建议，尽量放进 advice",
            "如果文本里包含从当前地点到下一地点的相关建议，尽量放进 next_segment_advice",
            "每识别出一个明确地名就立刻输出一行 place",
            "name 必须是明确地名，避免抽象词/泛称",
            "最后必须输出一行 done",
          ],
        },
        null,
        0,
      ),
    },
  ];
}

function buildStreamingVisionExtractionMessages(
  query: string,
  primaryLocation: string,
  guideText: string,
  images: string[],
): GlmMessage[] {
  const userContent: GlmContentPart[] = [];

  if (guideText.trim()) {
    userContent.push({
      type: "text",
      text: JSON.stringify(
        {
          query,
          primary_location: primaryLocation,
          content: guideText,
          constraints: [
            "必须先输出一行 meta",
            "如果输入内容不是旅游攻略、游记、行程图、路线图或景点安排，meta 和 done 中的 is_relevant_guide 必须为 false，且不要输出 place",
            "如果图片或文本里出现 Day1/Day2/Day3（或 第一天/第二天/第三天）等日程信息，尽量完整提取所有天的地点",
            "places 必须按完整行程顺序输出",
            "如果存在往返、回酒店或重复经过同一地点，必须保留重复地名，不要去重",
            "如果文本或图片里包含某个地点的相关建议，尽量放进 advice",
            "如果文本或图片里包含从当前地点到下一地点的相关建议，尽量放进 next_segment_advice",
            "每识别出一个明确地名就立刻输出一行 place",
            "name 必须是明确地名，避免抽象词/泛称",
            "最后必须输出一行 done",
          ],
        },
        null,
        0,
      ),
    });
  }

  userContent.push(
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: image,
      },
    })),
  );

  return [
    {
      role: "system",
      content:
        "你是旅行规划助手。请直接阅读用户提供的攻略文本和图片，边分析边输出 JSON Lines，每行一个 JSON 对象，不要输出 markdown 或解释。先尽快输出 meta，再每识别到一个地点就立刻输出一个 place，最后输出 done。允许的格式只有：{\"type\":\"meta\",\"is_relevant_guide\":true}, {\"type\":\"place\",\"name\":\"地名\",\"evidence\":\"证据\",\"day\":1,\"advice\":\"地点建议\",\"next_segment_advice\":\"去下一站的建议\"}, {\"type\":\"done\",\"is_relevant_guide\":true}。",
    },
    {
      role: "user",
      content: userContent,
    },
  ];
}

function normalizeLlmRoute(
  route: Omit<LLMRoute, "candidate_index"> | undefined,
  candidateIndex: number,
): LLMRoute | undefined {
  if (!route) {
    return undefined;
  }

  return {
    candidate_index: candidateIndex,
    places: Array.isArray(route.places) ? route.places : [],
    ...(typeof route.is_relevant_guide === "boolean"
      ? { is_relevant_guide: route.is_relevant_guide }
      : {}),
  };
}

function parseStreamEventLine(line: string): RouteExtractionStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = safeJsonParse(trimmed);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const event = parsed as Record<string, unknown>;
  if (event.type === "meta" && typeof event.is_relevant_guide === "boolean") {
    return {
      type: "meta",
      is_relevant_guide: event.is_relevant_guide,
    };
  }

  if (event.type === "place") {
    return {
      type: "place",
      ...(typeof event.name === "string" ? { name: event.name } : {}),
      ...(typeof event.evidence === "string" ? { evidence: event.evidence } : {}),
      ...(typeof event.day === "number" ? { day: event.day } : {}),
      ...(typeof event.advice === "string" ? { advice: event.advice } : {}),
      ...(typeof event.next_segment_advice === "string"
        ? { next_segment_advice: event.next_segment_advice }
        : {}),
    };
  }

  if (event.type === "done") {
    return {
      type: "done",
      ...(typeof event.is_relevant_guide === "boolean"
        ? { is_relevant_guide: event.is_relevant_guide }
        : {}),
    };
  }

  return null;
}

async function streamRouteExtraction(
  query: string,
  primaryLocation: string,
  candidate: GuideSearchResult,
  progress: { current: number; total: number },
  generatedAt: string,
  onRouteUpdate?: (
    route: RoutePlanResponse,
    progress: { current: number; total: number },
    done?: boolean,
  ) => void | Promise<void>,
): Promise<LLMRoute | undefined> {
  const messages = buildStreamingExtractionMessages(query, primaryLocation, candidate);
  const draftPlaces: Array<{
    name: string;
    evidence?: string;
    day?: number;
    advice?: string;
    next_segment_advice?: string;
  }> = [];
  let isRelevantGuide: boolean | undefined;
  let lineBuffer = "";

  const emitRouteUpdate = async (done?: boolean) => {
    if (draftPlaces.length === 0 || isRelevantGuide === false) {
      return;
    }

    const route = buildRouteFromCandidate(
      query,
      candidate,
      primaryLocation,
      normalizeLlmRoute(
        {
          places: draftPlaces,
          ...(typeof isRelevantGuide === "boolean"
            ? { is_relevant_guide: isRelevantGuide }
            : {}),
        },
        progress.current - 1,
      ),
      generatedAt,
    );
    if (!route) {
      return;
    }

    await onRouteUpdate?.(route, progress, done);
  };

  const consumeLine = async (line: string) => {
    const event = parseStreamEventLine(line);
    if (!event) {
      return;
    }

    if (event.type === "meta") {
      isRelevantGuide = event.is_relevant_guide;
      return;
    }

    if (event.type === "place") {
      const name = (event.name ?? "").trim();
      if (name.length < 2) {
        return;
      }
      draftPlaces.push({
        name,
        ...(typeof event.evidence === "string" && event.evidence.trim()
          ? { evidence: event.evidence.trim() }
          : {}),
        ...(typeof event.day === "number" && Number.isFinite(event.day)
          ? { day: event.day }
          : {}),
        ...(typeof event.advice === "string" && event.advice.trim()
          ? { advice: event.advice.trim() }
          : {}),
        ...(typeof event.next_segment_advice === "string" && event.next_segment_advice.trim()
          ? { next_segment_advice: event.next_segment_advice.trim() }
          : {}),
      });
      await emitRouteUpdate(false);
      return;
    }

    if (event.type === "done") {
      if (typeof event.is_relevant_guide === "boolean") {
        isRelevantGuide = event.is_relevant_guide;
      }
      await emitRouteUpdate(true);
    }
  };

  const fullText = await streamDeepSeekText(messages, async (delta) => {
    lineBuffer += delta;

    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      await consumeLine(line);
      newlineIndex = lineBuffer.indexOf("\n");
    }
  });

  if (lineBuffer.trim()) {
    await consumeLine(lineBuffer);
  }

  if (draftPlaces.length === 0 && fullText.trim()) {
    const parsed = safeJsonParse(fullText) as { route?: Omit<LLMRoute, "candidate_index"> } | null;
    return normalizeLlmRoute(parsed?.route, progress.current - 1);
  }

  return normalizeLlmRoute(
    {
      places: draftPlaces,
      ...(typeof isRelevantGuide === "boolean" ? { is_relevant_guide: isRelevantGuide } : {}),
    },
    progress.current - 1,
  );
}

async function streamVisionRouteExtraction(
  query: string,
  primaryLocation: string,
  guideText: string,
  images: string[],
  candidate: GuideSearchResult,
  progress: { current: number; total: number },
  generatedAt: string,
  onRouteUpdate?: (
    route: RoutePlanResponse,
    progress: { current: number; total: number },
    done?: boolean,
  ) => void | Promise<void>,
): Promise<LLMRoute | undefined> {
  const messages =
    images.length > 0
      ? buildStreamingVisionExtractionMessages(query, primaryLocation, guideText, images)
      : (buildStreamingExtractionMessages(query, primaryLocation, {
          ...candidate,
          snippet: guideText,
        }) as GlmMessage[]);
  const draftPlaces: Array<{
    name: string;
    evidence?: string;
    day?: number;
    advice?: string;
    next_segment_advice?: string;
  }> = [];
  let isRelevantGuide: boolean | undefined;
  let lineBuffer = "";

  const emitRouteUpdate = async (done?: boolean) => {
    if (draftPlaces.length === 0 || isRelevantGuide === false) {
      return;
    }

    const route = buildRouteFromCandidate(
      query,
      candidate,
      primaryLocation,
      normalizeLlmRoute(
        {
          places: draftPlaces,
          ...(typeof isRelevantGuide === "boolean"
            ? { is_relevant_guide: isRelevantGuide }
            : {}),
        },
        progress.current - 1,
      ),
      generatedAt,
      "direct_text_only",
    );
    if (!route) {
      return;
    }

    await onRouteUpdate?.(route, progress, done);
  };

  const consumeLine = async (line: string) => {
    const event = parseStreamEventLine(line);
    if (!event) {
      return;
    }

    if (event.type === "meta") {
      isRelevantGuide = event.is_relevant_guide;
      return;
    }

    if (event.type === "place") {
      const name = (event.name ?? "").trim();
      if (name.length < 2) {
        return;
      }
      draftPlaces.push({
        name,
        ...(typeof event.evidence === "string" && event.evidence.trim()
          ? { evidence: event.evidence.trim() }
          : {}),
        ...(typeof event.day === "number" && Number.isFinite(event.day)
          ? { day: event.day }
          : {}),
        ...(typeof event.advice === "string" && event.advice.trim()
          ? { advice: event.advice.trim() }
          : {}),
        ...(typeof event.next_segment_advice === "string" && event.next_segment_advice.trim()
          ? { next_segment_advice: event.next_segment_advice.trim() }
          : {}),
      });
      await emitRouteUpdate(false);
      return;
    }

    if (event.type === "done") {
      if (typeof event.is_relevant_guide === "boolean") {
        isRelevantGuide = event.is_relevant_guide;
      }
      await emitRouteUpdate(true);
    }
  };

  const fullText = await streamGlmText(messages, async (delta) => {
    lineBuffer += delta;

    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      await consumeLine(line);
      newlineIndex = lineBuffer.indexOf("\n");
    }
  });

  if (lineBuffer.trim()) {
    await consumeLine(lineBuffer);
  }

  if (draftPlaces.length === 0 && fullText.trim()) {
    const parsed = safeJsonParse(fullText) as { route?: Omit<LLMRoute, "candidate_index"> } | null;
    return normalizeLlmRoute(parsed?.route, progress.current - 1);
  }

  return normalizeLlmRoute(
    {
      places: draftPlaces,
      ...(typeof isRelevantGuide === "boolean" ? { is_relevant_guide: isRelevantGuide } : {}),
    },
    progress.current - 1,
  );
}

function buildRouteFromCandidate(
  query: string,
  candidate: GuideSearchResult,
  primaryLocation: string,
  llmRoute: LLMRoute | undefined,
  generatedAt: string,
  strategy: "zhihu_mafengwo_only" | "direct_text_only" = "zhihu_mafengwo_only",
): RoutePlanResponse | null {
  if (llmRoute?.is_relevant_guide === false) {
    return null;
  }

  const candidateSnippet = (candidate.snippet ?? "").trim();
  const places: RoutePlace[] = (Array.isArray(llmRoute?.places) ? llmRoute.places : [])
    .map((place, placeIndex) => ({
      name: (place.name ?? "").trim(),
      summary: (place.evidence ?? "").trim() || candidateSnippet,
      advice: (place.advice ?? "").trim(),
      nextSegmentAdvice: (place.next_segment_advice ?? "").trim(),
      day:
        typeof place.day === "number" && Number.isFinite(place.day) && place.day >= 1
          ? Math.floor(place.day)
          : undefined,
      placeIndex,
    }))
    .filter((place) => place.name.length >= 2)
    .sort((a, b) => {
      const aDay = a.day ?? Number.MAX_SAFE_INTEGER;
      const bDay = b.day ?? Number.MAX_SAFE_INTEGER;
      if (aDay !== bDay) return aDay - bDay;
      return a.placeIndex - b.placeIndex;
    })
    .map((place, placeIndex) => {
      const summary = toGuideSummary(place.summary);
      const normalizedSummary =
        typeof place.day === "number" && place.day >= 1 ? `Day${place.day}:${summary}` : summary;
      return {
        place_id: `place_${placeIndex + 1}`,
        order: placeIndex + 1,
        ...(typeof place.day === "number" ? { day: place.day } : {}),
        name: place.name,
        guide: {
          summary: normalizedSummary,
          ...(place.advice ? { advice: place.advice } : {}),
        },
      };
    });

  const url = (candidate.url ?? "").trim();
  const segments: RouteSegment[] = [];
    for (let i = 0; i < places.length - 1; i += 1) {
      const from = places[i];
      const to = places[i + 1];
      if (!from || !to) continue;
      const nextSegmentAdvice = (llmRoute?.places?.[i]?.next_segment_advice ?? "").trim();
      const guide =
        url || nextSegmentAdvice
          ? {
              ...(nextSegmentAdvice ? { strategy: nextSegmentAdvice } : {}),
              ...(url ? { references: [url] } : {}),
            }
          : undefined;
      segments.push({
        segment_id: `segment_${i + 1}`,
        order: i + 1,
        from_place_id: from.place_id,
        to_place_id: to.place_id,
        from_place_name: from.name,
        to_place_name: to.name,
        ...(guide ? { guide } : {}),
      });
    }

  return {
    type: "route_plan",
    query,
    source: candidate.source_type,
    strategy,
    overview:
      places.length > 0
        ? "已根据该条攻略生成路线，请按 places 顺序游览。"
        : "该攻略未能抽取到明确地名。",
    places,
    segments,
    metadata: {
      result_count: places.length,
      generated_at: generatedAt,
    },
    ...(candidate.title ? { note: `来源攻略：${candidate.title}` } : {}),
    original: {
      ...(candidate.title ? { title: candidate.title } : {}),
      ...(candidate.url ? { url: candidate.url } : {}),
      ...(candidateSnippet ? { snippet: candidateSnippet } : {}),
      ...(candidate.site_name ? { site_name: candidate.site_name } : {}),
      ...(candidate.published_at ? { published_at: candidate.published_at } : {}),
      ...(candidate.source_type ? { source_type: candidate.source_type } : {}),
      ...(primaryLocation ? { primary_location: primaryLocation } : {}),
    },
  };
}

function buildRoutePlanBatch(
  data: {
    source?: string;
    strategy?: "zhihu_mafengwo_only" | "direct_text_only";
    total_candidates?: number;
    guide_search_url?: string;
    rate_limited?: boolean;
  },
  query: string,
  routes: RoutePlanResponse[],
  filteredNoiseCount: number,
): RoutePlanBatchResponse {
  const nowIso = new Date().toISOString();
  const totalCandidates = Number(data.total_candidates ?? 0);
  const guideSearchUrl =
    typeof data.guide_search_url === "string" ? data.guide_search_url : undefined;
  const routeCountNonEmpty = routes.filter((route) => route.places.length > 0).length;

  const batch: RoutePlanBatchResponse = {
    type: "route_plan_batch",
    query,
    source: data.source ?? DEFAULT_GUIDE_SOURCE,
    strategy: data.strategy ?? "zhihu_mafengwo_only",
    overview:
      routeCountNonEmpty > 0 ? "已为每条攻略生成独立路线。" : "未能从攻略中抽取到可用地名。",
    routes,
    metadata: {
      total_candidates: totalCandidates,
      route_count: routes.length,
      generated_at: nowIso,
      ...(guideSearchUrl ? { guide_search_url: guideSearchUrl } : {}),
    },
  };

  if (routeCountNonEmpty === 0) {
    if (data.strategy === "direct_text_only") {
      batch.note = "已处理提供的攻略文本，但未提取到明确地名。";
    } else if (data.rate_limited) {
      batch.note = "攻略检索触发 Bocha 限流（429），请稍后重试。";
    } else if (filteredNoiseCount > 0 && routes.length === 0) {
      batch.note = "已过滤掉非旅游攻略的噪音结果，请换更具体主地点或稍后重试。";
    } else {
      batch.note = "已检索到知乎/马蜂窝结果，但未提取到明确地名。建议换更具体主地点重试。";
    }
  }

  return batch;
}

async function buildRoutePlan(
  guideInput: GuideExtractionInput,
  query: string,
  callbacks?: GuideProgressCallbacks,
): Promise<RoutePlanBatchResponse> {
  const data = guideInput;
  const strategy = data.strategy ?? "zhihu_mafengwo_only";

  const guideCandidates = (Array.isArray(data.results) ? data.results : []).slice(0, 8);
  const primaryLocation = (data.primary_location ?? "").trim();
  const totalCandidates = Number(data.total_candidates ?? 0);
  const guideSearchUrl =
    typeof data.guide_search_url === "string" ? data.guide_search_url : undefined;

  if (guideCandidates.length === 0) {
    return {
      type: "route_plan_batch",
      query,
      source: data.source ?? DEFAULT_GUIDE_SOURCE,
      strategy,
      overview: "未能从攻略中抽取到可用地名。",
      routes: [],
      metadata: {
        total_candidates: totalCandidates,
        route_count: 0,
        generated_at: new Date().toISOString(),
        ...(guideSearchUrl ? { guide_search_url: guideSearchUrl } : {}),
      },
      note: data.rate_limited
        ? "攻略检索触发 Bocha 限流（429），请稍后重试。"
        : "没有检索到知乎或马蜂窝站点的可用攻略结果。",
    };
  }

  await callbacks?.onStatus?.("extracting_places", "正在提取攻略中的地点与路线");

  const nowIso = new Date().toISOString();
  const extracted = await Promise.all(
    guideCandidates.map(async (candidate, idx) => {
      await callbacks?.onStatus?.(
        "extracting_candidate",
        `正在提取第 ${idx + 1}/${guideCandidates.length} 条攻略中的地点与路线`,
      );

      const extractionMessages = buildExtractionMessages(query, primaryLocation, candidate);
      const llmResp = await callDeepSeek(extractionMessages);
      const llmContent = llmResp.choices?.[0]?.message?.content ?? "";
      const parsed = safeJsonParse(llmContent) as
        | { route?: Omit<LLMRoute, "candidate_index"> }
        | null;
      const llmRoute = parsed?.route
        ? {
            candidate_index: idx,
            places: Array.isArray(parsed.route.places) ? parsed.route.places : [],
            ...(typeof parsed.route.is_relevant_guide === "boolean"
              ? { is_relevant_guide: parsed.route.is_relevant_guide }
              : {}),
          }
        : undefined;

      if (llmRoute?.is_relevant_guide === false) {
        await callbacks?.onCandidateProcessed?.({
          progress: {
            current: idx + 1,
            total: guideCandidates.length,
          },
          skipped: true,
          reason: "noise",
          ...(candidate.title ? { title: candidate.title } : {}),
          ...(candidate.url ? { url: candidate.url } : {}),
        });
        return { route: null, isNoise: true };
      }

      const route = buildRouteFromCandidate(query, candidate, primaryLocation, llmRoute, nowIso);
      if (!route) {
        await callbacks?.onCandidateProcessed?.({
          progress: {
            current: idx + 1,
            total: guideCandidates.length,
          },
          skipped: true,
          reason: "empty_places",
          ...(candidate.title ? { title: candidate.title } : {}),
          ...(candidate.url ? { url: candidate.url } : {}),
        });
        return { route: null, isNoise: false };
      }

      await callbacks?.onCandidateProcessed?.({
        progress: {
          current: idx + 1,
          total: guideCandidates.length,
        },
        route,
      });
      if (route.places.length > 0) {
        await callbacks?.onPartialRoute?.(route, {
          current: idx + 1,
          total: guideCandidates.length,
        });
      }

      return { route, isNoise: false };
    }),
  );

  const routes = extracted
    .map((item) => item.route)
    .filter((route): route is RoutePlanResponse => Boolean(route));
  const filteredNoiseCount = extracted.filter((item) => item.isNoise).length;

  return buildRoutePlanBatch(
    {
      total_candidates: totalCandidates,
      ...(data.source ? { source: data.source } : {}),
      strategy,
      ...(guideSearchUrl ? { guide_search_url: guideSearchUrl } : {}),
      ...(typeof data.rate_limited === "boolean" ? { rate_limited: data.rate_limited } : {}),
    },
    query,
    routes,
    filteredNoiseCount,
  );
}

export async function runDirectGuidePlan(
  input: DirectGuideInput,
  callbacks?: GuideProgressCallbacks,
): Promise<RoutePlanBatchResponse> {
  const guideText = (input.content ?? "").trim();
  const images = Array.isArray(input.images) ? input.images.map((image) => image.trim()).filter(Boolean) : [];
  if (!guideText && images.length === 0) {
    throw new Error("content or images is required");
  }

  if (!callbacks && images.length > 0) {
    throw new Error("images are only supported on /guide/stream");
  }

  const query = "根据提供的攻略文本生成路线";
  const primaryLocation = "";

  if (callbacks) {
    const nowIso = new Date().toISOString();
    const candidate: GuideSearchResult = {
      title: "用户提供的攻略文本",
      url: "",
      snippet: guideText,
      site_name: "用户提供",
      published_at: "",
      source_type: "direct_text",
    };

    await callbacks.onStatus?.("extracting_places", "正在提取攻略中的地点与路线");
    const llmRoute = await streamVisionRouteExtraction(
      query,
      primaryLocation,
      guideText,
      images,
      candidate,
      { current: 1, total: 1 },
      nowIso,
      async (draftRoute) => {
        if (draftRoute.places.length === 0) {
          return;
        }
        await callbacks.onResult?.(
          buildRoutePlanBatch(
            {
              source: "direct_text",
              strategy: "direct_text_only",
              total_candidates: 1,
            },
            query,
            [draftRoute],
            0,
          ),
        );
      },
    );

    const route = buildRouteFromCandidate(
      query,
      candidate,
      primaryLocation,
      llmRoute,
      nowIso,
      "direct_text_only",
    );

    return buildRoutePlanBatch(
      {
        source: "direct_text",
        strategy: "direct_text_only",
        total_candidates: 1,
      },
      query,
      route && route.places.length > 0 ? [route] : [],
      llmRoute?.is_relevant_guide === false ? 1 : 0,
    );
  }

  return buildRoutePlan(
    {
      query,
      source: "direct_text",
      strategy: "direct_text_only",
      primary_location: primaryLocation,
      total_candidates: 1,
      results: [
        {
          title: "用户提供的攻略文本",
          url: "",
          snippet: guideText,
          site_name: "用户提供",
          published_at: "",
          source_type: "direct_text",
        },
      ],
    },
    query,
    callbacks,
  );
}

export async function runGuideSearchByPlace(
  input: GuideRunOptions,
): Promise<RoutePlanBatchResponse> {
  const placeName = input.placeName.trim();
  if (!placeName) {
    return buildGuideFailure(
      input.userPrompt,
      "缺少主地点，请在请求里带上城市、区或街道，例如：深圳南山区旅游攻略。",
    );
  }

  await input.callbacks?.onStatus?.("searching_guides", "正在检索攻略来源");
  if (input.callbacks) {
    const maxResults = 8;
    const nowIso = new Date().toISOString();
    const searchData = await collectTravelGuideSearch({
      place_name: placeName,
      max_results: maxResults,
      original_query: input.userPrompt,
    });

    const guideCandidates = (Array.isArray(searchData.results) ? searchData.results : []).slice(0, maxResults);
    if (guideCandidates.length === 0) {
      return buildRoutePlanBatch(searchData, input.userPrompt, [], 0);
    }

    await input.callbacks?.onStatus?.("extracting_places", "正在提取攻略中的地点与路线");

    const currentRoutes = new Array<RoutePlanResponse | undefined>(guideCandidates.length).fill(undefined);
    const noiseFlags = new Array<boolean>(guideCandidates.length).fill(false);

    const emitSnapshot = async () => {
      await input.callbacks?.onResult?.(
        buildRoutePlanBatch(
          {
            source: "Bocha",
            total_candidates: searchData.total_candidates,
            ...(searchData.guide_search_url ? { guide_search_url: searchData.guide_search_url } : {}),
          },
          input.userPrompt,
          currentRoutes.filter((route): route is RoutePlanResponse => Boolean(route)),
          noiseFlags.filter(Boolean).length,
        ),
      );
    };

    await Promise.all(
      guideCandidates.map(async (candidate, idx) => {
        await input.callbacks?.onStatus?.(
          "extracting_candidate",
          `正在提取第 ${idx + 1}/${guideCandidates.length} 条攻略中的地点与路线`,
        );

        const llmRoute = await streamRouteExtraction(
          input.userPrompt,
          placeName,
          candidate,
          {
            current: idx + 1,
            total: guideCandidates.length,
          },
          nowIso,
          async (draftRoute) => {
            if (draftRoute.places.length === 0) {
              return;
            }
            currentRoutes[idx] = draftRoute;
            await emitSnapshot();
          },
        );

        if (llmRoute?.is_relevant_guide === false) {
          noiseFlags[idx] = true;
          currentRoutes[idx] = undefined;
          return;
        }

        const route = buildRouteFromCandidate(
          input.userPrompt,
          candidate,
          placeName,
          llmRoute,
          nowIso,
        );
        currentRoutes[idx] = route && route.places.length > 0 ? route : undefined;
        await emitSnapshot();
      }),
    );

    return buildRoutePlanBatch(
      searchData,
      input.userPrompt,
      currentRoutes.filter((route): route is RoutePlanResponse => Boolean(route)),
      noiseFlags.filter(Boolean).length,
    );
  }

  const toolOutput = await searchTravelGuideByPlace({
    place_name: placeName,
    max_results: 8,
    original_query: input.userPrompt,
  });
  return buildRoutePlan(JSON.parse(toolOutput) as GuideExtractionInput, input.userPrompt, input.callbacks);
}

export async function runGuidePlan(
  userPrompt: string,
  callbacks?: GuideProgressCallbacks,
): Promise<RoutePlanBatchResponse> {
  const tools = [GUIDE_TOOL];

  const messages: ModelMessage[] = [
    {
      role: "system",
      content:
        "当用户要旅游攻略时，你必须从当前对话中提取地名并调用 search_travel_guide。地名识别完全由你负责，代码不会再做地名拆分、别名补全或纠错。该工具会检索知乎和马蜂窝，必须提供 place_name，且 place_name 必须只包含地名本身（城市/区/街道/景区名），不要带天气、日期、预算、人数、玩法偏好等附加条件。如果无法识别地名，不要猜测，直接返回需要补充地名。",
    },
    { role: "user", content: userPrompt },
  ];

  try {
    await callbacks?.onStatus?.("detecting_place", "正在识别目的地");
    const completion = await callDeepSeek(messages, tools);
    const assistantMessage = completion.choices?.[0]?.message;
    const rawToolCalls = assistantMessage?.tool_calls;
    const toolCalls: DeepSeekToolCall[] = Array.isArray(rawToolCalls)
      ? (rawToolCalls as DeepSeekToolCall[])
      : [];

    const guideToolCall = toolCalls.find(
      (call) => call.function?.name === "search_travel_guide",
    );
    if (!guideToolCall) {
      return buildGuideFailure(
        userPrompt,
        "缺少主地点，请在问题中明确地名（城市、区或街道），例如：上海静安区旅游攻略。",
      );
    }

    const args = JSON.parse(guideToolCall.function?.arguments ?? "{}") as {
      place_name?: unknown;
    };
    const placeName =
      typeof args.place_name === "string" ? args.place_name.trim() : "";
    return runGuideSearchByPlace({
      userPrompt,
      placeName,
      ...(callbacks ? { callbacks } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return buildGuideFailure(userPrompt, message);
  }
}
