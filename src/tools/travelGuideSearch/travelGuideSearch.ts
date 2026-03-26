type PlaceSearchInput = {
  place_name: string;
  max_results?: number;
  original_query?: string;
};

type NormalizedResult = {
  title: string;
  url: string;
  snippet: string;
  site_name: string;
  published_at: string;
};

type RawSearchResult = NormalizedResult & {
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

type GuideSearchCallbacks = {
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

const bochaApiKey = process.env.BOCHA_API_KEY;
const bochaApiBaseUrl = (process.env.BOCHA_API_BASE_URL ?? "https://api.bocha.cn").replace(
  /\/+$/,
  "",
);

function buildPlannedQueries(placeName: string) {
  const queries = [
    `site:zhihu.com ${placeName} 旅游攻略`,
    `site:zhihu.com ${placeName} 旅行 行程`,
    `site:zhihu.com ${placeName} 哪里好玩`,
    `site:mafengwo.cn ${placeName} 旅游攻略`,
    `site:mafengwo.com ${placeName} 旅游攻略`,
    `${placeName} 马蜂窝 自由行`,
  ];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (seen.has(query)) {
      continue;
    }
    seen.add(query);
    deduped.push(query);
  }
  return deduped.slice(0, 6);
}

async function callBochaWebSearch(query: string, count: number) {
  const response = await fetch(`${bochaApiBaseUrl}/v1/web-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bochaApiKey}`,
    },
    body: JSON.stringify({
      query,
      count,
      summary: false,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Bocha request failed ${response.status}: ${details}`);
  }

  const data = await response.json();
  const webSearchUrl = String(data?.data?.webPages?.webSearchUrl ?? "");
  const candidates =
    (Array.isArray(data?.data?.webPages?.value) && data.data.webPages.value) ||
    (Array.isArray(data?.data?.results) && data.data.results) ||
    (Array.isArray(data?.results) && data.results) ||
    [];

  const normalized: NormalizedResult[] = candidates
    .map((item: Record<string, unknown>) => ({
      title: String(item.title ?? item.name ?? item.heading ?? ""),
      url: String(item.url ?? item.link ?? ""),
      snippet: String(item.snippet ?? item.summary ?? item.description ?? ""),
      site_name: String(item.siteName ?? item.source ?? ""),
      published_at: String(item.datePublished ?? ""),
    }))
    .filter((item: { url: string }) => item.url.length > 0);

  return { normalized, webSearchUrl };
}

export async function collectTravelGuideSearch(
  input: PlaceSearchInput,
  callbacks?: GuideSearchCallbacks,
): Promise<GuideSearchData> {
  if (!bochaApiKey) {
    throw new Error("BOCHA_API_KEY is missing");
  }

  const maxResults = Math.min(Math.max(input.max_results ?? 5, 1), 10);
  const requestCount = Math.max(maxResults * 2, 12);
  const placeName = input.place_name.trim();
  if (!placeName || placeName.length < 2) {
    throw new Error("缺少主地点，请在请求里带上城市、区或街道，例如：深圳南山区旅游攻略。");
  }

  const plannedQueries = buildPlannedQueries(placeName);

  const seenResultUrls = new Set<string>();
  const guideResults: GuideSearchResult[] = [];

  let totalCandidates = 0;
  let guideSearchUrl = "";
  const rawSearchResults: RawSearchResult[] = [];
  const queryResults = await Promise.all(
    plannedQueries.map(async (query) => {
      try {
        const response = await callBochaWebSearch(query, requestCount);
        return {
          query,
          normalized: response.normalized,
          webSearchUrl: response.webSearchUrl,
          rateLimited: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("Bocha request failed 429")) {
          return {
            query,
            normalized: [] as NormalizedResult[],
            webSearchUrl: "",
            rateLimited: true,
          };
        }
        throw error;
      }
    }),
  );

  const rateLimited = queryResults.some((item) => item.rateLimited);

  for (const [queryIndex, queryResult] of queryResults.entries()) {
    if (!guideSearchUrl && queryResult.webSearchUrl) {
      guideSearchUrl = queryResult.webSearchUrl;
    }
    totalCandidates += queryResult.normalized.length;
    const newGuideResults: GuideSearchResult[] = [];

    for (const item of queryResult.normalized) {
      if (rawSearchResults.length < 80) {
        rawSearchResults.push({
          ...item,
          query: queryResult.query,
          provider: "bocha",
        });
      }

      if (seenResultUrls.has(item.url)) {
        continue;
      }
      seenResultUrls.add(item.url);

      if (guideResults.length >= maxResults) {
        continue;
      }
      const result: GuideSearchResult = {
        ...item,
        source_type: "bocha",
      };
      guideResults.push(result);
      newGuideResults.push(result);
    }

    if (newGuideResults.length > 0) {
      await callbacks?.onCandidates?.(newGuideResults, {
        planned_query_index: queryIndex + 1,
        planned_query_total: plannedQueries.length,
        collected_result_count: guideResults.length,
        total_candidates: totalCandidates,
        query: queryResult.query,
      });
    }
  }

  return {
    query: placeName,
    original_query: input.original_query ?? input.place_name,
    primary_location: placeName,
    source: "Bocha",
    site: "zhihu.com,mafengwo.cn,mafengwo.com",
    results: guideResults,
    guide_search_url: guideSearchUrl,
    total_candidates: totalCandidates,
    used_fallback_other_sources: false,
    has_other_sources: false,
    used_weak_match_fallback: false,
    planned_queries: plannedQueries,
    rate_limited: rateLimited,
    raw_search_results: rawSearchResults,
  };
}

export async function searchTravelGuideByPlace(input: PlaceSearchInput) {
  const data = await collectTravelGuideSearch(input);
  return JSON.stringify(data);
}
