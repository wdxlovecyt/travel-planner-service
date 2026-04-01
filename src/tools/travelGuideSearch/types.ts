export type PlaceSearchInput = {
  place_name: string;
  max_results?: number;
  original_query?: string;
};

export type NormalizedResult = {
  title: string;
  url: string;
  snippet: string;
  site_name: string;
  published_at: string;
};

export type RawSearchResult = NormalizedResult & {
  query: string;
  provider: "bocha";
};

export type GuideResultSourceType = "bocha" | "direct_text";

export type GuideSearchResult = NormalizedResult & {
  source_type: GuideResultSourceType;
};

export type GuideSearchData = {
  query: string;
  original_query: string;
  primary_location: string;
  source: "Bocha";
  site: string;
  results: GuideSearchResult[];
  guide_search_url: string;
  total_candidates: number;
  used_fallback_other_sources: false;
  has_other_sources: false;
  used_weak_match_fallback: false;
  planned_queries: string[];
  rate_limited: boolean;
  raw_search_results: RawSearchResult[];
};

export type GuideSearchCallbacks = {
  onCandidates?: (
    candidates: GuideSearchResult[],
    progress: {
      planned_query_index: number;
      planned_query_total: number;
      collected_result_count: number;
      total_candidates: number;
      query: string;
    },
  ) => void | Promise<void>;
};
