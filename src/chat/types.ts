export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
};

export type DeepSeekToolCall = {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type RoutePlace = {
  place_id: string;
  order: number;
  day?: number;
  name: string;
  guide: {
    summary: string;
    advice?: string;
  };
};

export type RouteSegment = {
  segment_id: string;
  order: number;
  from_place_id: string;
  to_place_id: string;
  from_place_name: string;
  to_place_name: string;
  transport?: {
    mode?: string;
    duration_estimate?: string;
  };
  guide?: {
    strategy?: string;
    references?: string[];
  };
};

export type RoutePlanResponse = {
  type: "route_plan";
  query: string;
  source: string;
  strategy: "zhihu_mafengwo_only" | "direct_text_only";
  overview: string;
  places: RoutePlace[];
  segments: RouteSegment[];
  original?: {
    title?: string;
    url?: string;
    snippet?: string;
    site_name?: string;
    published_at?: string;
    source_type?: string;
    primary_location?: string;
  };
  metadata: {
    result_count: number;
    generated_at: string;
  };
  note?: string;
};

export type RoutePlanBatchResponse = {
  type: "route_plan_batch";
  query: string;
  source: string;
  strategy: "zhihu_mafengwo_only" | "direct_text_only";
  overview: string;
  routes: RoutePlanResponse[];
  metadata: {
    total_candidates: number;
    route_count: number;
    generated_at: string;
    guide_search_url?: string;
  };
  note?: string;
};

export type GuideRunOptions = {
  userPrompt: string;
  placeName: string;
  callbacks?: GuideProgressCallbacks;
};

export type LLMRoute = {
  candidate_index: number;
  is_relevant_guide?: boolean;
  places: Array<{
    name: string;
    evidence?: string;
    day?: number;
    advice?: string;
    next_segment_advice?: string;
  }>;
};

export type GuideProgressCallbacks = {
  onStatus?: (stage: string, message: string) => void | Promise<void>;
  onResult?: (result: RoutePlanBatchResponse) => void | Promise<void>;
  onPartialRoute?: (
    route: RoutePlanResponse,
    progress: { current: number; total: number },
  ) => void | Promise<void>;
  onCandidateProcessed?: (
    payload: {
      progress: { current: number; total: number };
      route?: RoutePlanResponse;
      skipped?: boolean;
      reason?: "noise" | "empty_places";
      title?: string;
      url?: string;
    },
  ) => void | Promise<void>;
};

export type RouteExtractionStreamEvent =
  | {
      type: "meta";
      is_relevant_guide: boolean;
    }
  | {
      type: "place";
      name?: string;
      evidence?: string;
      day?: number;
      advice?: string;
      next_segment_advice?: string;
    }
  | {
      type: "done";
      is_relevant_guide?: boolean;
    };

export type GuideExtractionInput = {
  query: string;
  source?: string;
  strategy?: "zhihu_mafengwo_only" | "direct_text_only";
  results?: import("../tools/travelGuideSearch/travelGuideSearch.js").GuideSearchResult[];
  total_candidates?: number;
  guide_search_url?: string;
  primary_location?: string;
  rate_limited?: boolean;
};

export type DirectGuideTextInput = {
  guide_text: string;
  message?: string;
  title?: string;
  url?: string;
  site_name?: string;
  published_at?: string;
  primary_location?: string;
};

export type ChatComboResult = {
  type: "chat_combo";
  reply: string;
  route_plan: RoutePlanBatchResponse;
};

export type ChatResult = string | RoutePlanResponse | RoutePlanBatchResponse | ChatComboResult;

export type WeatherStreamCallbacks = {
  onStatus?: (stage: string, message: string) => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
};
