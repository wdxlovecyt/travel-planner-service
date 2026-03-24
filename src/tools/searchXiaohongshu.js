const bochaApiKey = process.env.BOCHA_API_KEY;
const bochaApiBaseUrl = (process.env.BOCHA_API_BASE_URL ?? "https://api.bocha.cn").replace(/\/+$/, "");
const STRONG_TRAVEL_INTENT_PATTERN = /旅游|旅行|自由行|行程|路线|景点|打卡|citywalk|游玩|玩法|周边游|出游|攻略游记/i;
const LIGHT_TRAVEL_INTENT_PATTERN = /好玩|去玩|玩耍|玩一下|哪里玩|推荐一下|值得去/i;
const GUIDE_WORD_PATTERN = /攻略/i;
const TRAVEL_CONTEXT_PATTERN = /旅游|旅行|行程|景点|目的地|出行|打卡|游玩|交通|住宿|酒店|门票|美食|古镇|公园|博物馆|步行街|商圈/i;
const NON_TRAVEL_NOISE_PATTERN = /openclaw|minimax|扫地机器人|冰箱|联系我们|技能|skill|网络底座|ai\s*agent|家电|博查搜索/i;
function buildTopicKeywords(topic) {
    return topic
        .toLowerCase()
        .split(/[\s,，。;；、|/\\\-]+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2);
}
function hasTravelIntent(item) {
    const text = `${item.title} ${item.snippet}`;
    if (NON_TRAVEL_NOISE_PATTERN.test(text)) {
        return false;
    }
    if (STRONG_TRAVEL_INTENT_PATTERN.test(text)) {
        return true;
    }
    if (LIGHT_TRAVEL_INTENT_PATTERN.test(text) && TRAVEL_CONTEXT_PATTERN.test(text)) {
        return true;
    }
    return GUIDE_WORD_PATTERN.test(text) && TRAVEL_CONTEXT_PATTERN.test(text);
}
function buildLocationAliases(primaryLocation) {
    const compact = primaryLocation.toLowerCase().replace(/\s+/g, "");
    const aliases = new Set();
    if (!compact) {
        return [];
    }
    aliases.add(compact);
    const cityDistrictMatch = compact.match(/^([\u4e00-\u9fa5]{2,4})(?:市)?([\u4e00-\u9fa5]{1,16}(?:区|县|旗|镇|乡|街道|街|路|巷|村|湾|湖|山|公园|古城|古镇|步行街|商圈|景区))$/);
    if (cityDistrictMatch?.[1]) {
        aliases.add(cityDistrictMatch[1]);
    }
    if (cityDistrictMatch?.[2]) {
        const district = cityDistrictMatch[2];
        aliases.add(district);
        const districtCore = district.replace(/(区|县|旗|镇|乡|街道|街|路|巷|村|湾|湖|山|公园|古城|古镇|步行街|商圈|景区)$/g, "");
        if (districtCore.length >= 2) {
            aliases.add(districtCore);
        }
    }
    for (const part of primaryLocation
        .split(/[\s,，。;；、|/\\\-]+/)
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length >= 2)) {
        aliases.add(part);
        const core = part.replace(/(区|县|旗|镇|乡|街道|街|路|巷|村|湾|湖|山|公园|古城|古镇|步行街|商圈|景区)$/g, "");
        if (core.length >= 2) {
            aliases.add(core);
        }
    }
    return Array.from(aliases);
}
function containsPrimaryLocation(item, primaryLocation) {
    if (!primaryLocation) {
        return false;
    }
    const aliases = buildLocationAliases(primaryLocation);
    if (aliases.length === 0) {
        return false;
    }
    const haystack = `${item.title} ${item.snippet}`
        .toLowerCase()
        .replace(/\s+/g, "");
    return aliases.some((alias) => haystack.includes(alias));
}
function stripWeatherContext(query) {
    const stripped = query
        .replace(/根据天气|结合天气|按天气|看天气|天气如何|天气怎么样|天气情况|天气预报|温度|气温|湿度|降雨|下雨|晴天|阴天|多云|风力|北风|南风|东风|西风|几度|°c|℃|摄氏度/gi, " ")
        .replace(/[，。,.!！?？:：;；]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return stripped || query.trim();
}
function normalizePlaceName(rawPlace) {
    return stripWeatherContext(rawPlace)
        .replace(/["'`]/g, " ")
        .replace(/[，。,.!！?？:：;；]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function splitChineseCompositeLocation(place) {
    const compact = place.trim();
    const cityIndex = compact.indexOf("市");
    if (cityIndex <= 0 || cityIndex >= compact.length - 1) {
        return compact;
    }
    const city = compact.slice(0, cityIndex);
    const district = compact.slice(cityIndex + 1);
    if (!district) {
        return compact;
    }
    return `${city} ${district}`.trim();
}
function buildPlannedQueries(normalizedPlace) {
    const splitPlace = splitChineseCompositeLocation(normalizedPlace);
    const queries = [
        `site:zhihu.com ${normalizedPlace} 旅游攻略`,
        `site:zhihu.com ${normalizedPlace} 旅行 行程`,
        `site:zhihu.com ${normalizedPlace} 哪里好玩`,
        `site:mafengwo.cn ${normalizedPlace} 旅游攻略`,
        `site:mafengwo.com ${normalizedPlace} 旅游攻略`,
        `${normalizedPlace} 马蜂窝 自由行`,
    ];
    if (splitPlace && splitPlace !== normalizedPlace) {
        queries.push(`site:zhihu.com ${splitPlace} 旅游攻略`);
        queries.push(`site:mafengwo.cn ${splitPlace} 旅游攻略`);
    }
    const deduped = [];
    const seen = new Set();
    for (const query of queries) {
        if (seen.has(query)) {
            continue;
        }
        seen.add(query);
        deduped.push(query);
    }
    return deduped.slice(0, 6);
}
function platformFromUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.includes("zhihu.com")) {
            return "zhihu";
        }
        if (host.includes("mafengwo.cn") || host.includes("mafengwo.com")) {
            return "mafengwo";
        }
        return null;
    }
    catch {
        return null;
    }
}
function isRelevantByTopic(item, keywords) {
    if (keywords.length === 0) {
        return true;
    }
    const text = `${item.title} ${item.snippet}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
}
function getUrlPath(url) {
    try {
        return new URL(url).pathname.toLowerCase();
    }
    catch {
        return "";
    }
}
function hasGuideFriendlyPath(item, platform) {
    const path = getUrlPath(item.url);
    if (!path) {
        return false;
    }
    if (platform === "zhihu") {
        return (path.includes("/question/") ||
            path.includes("/answer/") ||
            path.includes("/p/"));
    }
    return (path.includes("/wenda/") ||
        path.includes("/gonglve/") ||
        path.includes("/mdd/") ||
        path.includes("/i/") ||
        path.includes("/travel-scenic-spot"));
}
function isLowValuePage(item, platform) {
    const path = getUrlPath(item.url);
    const title = item.title.toLowerCase();
    if (platform === "zhihu") {
        return path === "/contact" || title.includes("联系我们");
    }
    return path.includes("/localdeals/") || title.includes("无线官网");
}
function scoreGuideCandidate(item, platform, normalizedPlace, keywords) {
    let score = 0;
    if (hasTravelIntent(item)) {
        score += 4;
    }
    else {
        score -= 1;
    }
    if (containsPrimaryLocation(item, normalizedPlace)) {
        score += 3;
    }
    if (isRelevantByTopic(item, keywords)) {
        score += 2;
    }
    else {
        score -= 2;
    }
    if (hasGuideFriendlyPath(item, platform)) {
        score += 2;
    }
    if (isLowValuePage(item, platform)) {
        score -= 5;
    }
    return score;
}
async function callBochaWebSearch(query, count) {
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
    const candidates = (Array.isArray(data?.data?.webPages?.value) && data.data.webPages.value) ||
        (Array.isArray(data?.data?.results) && data.data.results) ||
        (Array.isArray(data?.results) && data.results) ||
        [];
    const normalized = candidates
        .map((item) => ({
        title: String(item.title ?? item.name ?? item.heading ?? ""),
        url: String(item.url ?? item.link ?? ""),
        snippet: String(item.snippet ?? item.summary ?? item.description ?? ""),
        site_name: String(item.siteName ?? item.source ?? ""),
        published_at: String(item.datePublished ?? ""),
    }))
        .filter((item) => item.url.length > 0);
    return { normalized, webSearchUrl };
}
export async function searchXiaohongshuGuideByPlace(input) {
    if (!bochaApiKey) {
        throw new Error("BOCHA_API_KEY is missing");
    }
    const maxResults = Math.min(Math.max(input.max_results ?? 5, 1), 10);
    const requestCount = Math.max(maxResults * 2, 12);
    const normalizedPlace = normalizePlaceName(input.place_name);
    if (!normalizedPlace || normalizedPlace.length < 2) {
        throw new Error("缺少主地点，请在请求里带上城市、区或街道，例如：深圳南山区旅游攻略。");
    }
    const locationAliases = buildLocationAliases(normalizedPlace).filter((item) => item.length >= 2);
    const keywords = Array.from(new Set([...buildTopicKeywords(normalizedPlace), ...locationAliases]));
    const plannedQueries = buildPlannedQueries(normalizedPlace);
    const seenResultUrls = new Set();
    const strictResults = [];
    const weakResults = [];
    const weakSeen = new Set();
    let totalCandidates = 0;
    let guideSearchUrl = "";
    let rateLimited = false;
    const rawSearchResults = [];
    const runQuery = async (query) => {
        let normalized = [];
        let currentSearchUrl = "";
        try {
            const response = await callBochaWebSearch(query, requestCount);
            normalized = response.normalized;
            currentSearchUrl = response.webSearchUrl;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message.includes("Bocha request failed 429")) {
                rateLimited = true;
                return;
            }
            throw error;
        }
        if (!guideSearchUrl && currentSearchUrl) {
            guideSearchUrl = currentSearchUrl;
        }
        totalCandidates += normalized.length;
        for (const item of normalized) {
            const platform = platformFromUrl(item.url);
            if (rawSearchResults.length < 80) {
                rawSearchResults.push({
                    ...item,
                    query,
                    provider: "bocha",
                    is_target_site: platform !== null,
                    site_platform: platform ?? "other",
                });
            }
            if (seenResultUrls.has(item.url)) {
                continue;
            }
            seenResultUrls.add(item.url);
            if (!platform) {
                continue;
            }
            const score = scoreGuideCandidate(item, platform, normalizedPlace, keywords);
            if (score < 2) {
                continue;
            }
            const candidate = { ...item, platform, relevance_score: score };
            if (containsPrimaryLocation(item, normalizedPlace)) {
                strictResults.push(candidate);
            }
            else if (!weakSeen.has(item.url)) {
                weakSeen.add(item.url);
                weakResults.push(candidate);
            }
            if (rawSearchResults.length > 0) {
                const lastIndex = rawSearchResults.length - 1;
                const last = rawSearchResults[lastIndex];
                if (last && last.url === item.url) {
                    rawSearchResults[lastIndex] = {
                        ...last,
                        relevance_score: score,
                    };
                }
            }
        }
    };
    for (const query of plannedQueries) {
        await runQuery(query);
        if (rateLimited) {
            break;
        }
        if (strictResults.length >= Math.min(maxResults, 4)) {
            break;
        }
    }
    strictResults.sort((a, b) => b.relevance_score - a.relevance_score);
    weakResults.sort((a, b) => b.relevance_score - a.relevance_score);
    const selectedStrict = strictResults.slice(0, maxResults);
    const selected = selectedStrict.length > 0 ? selectedStrict : weakResults.slice(0, maxResults);
    const usedWeakMatchFallback = selectedStrict.length === 0 && selected.length > 0;
    const results = selected.map((item) => ({
        ...item,
        source_type: item.platform,
    }));
    return JSON.stringify({
        query: normalizedPlace,
        original_query: input.original_query ?? input.place_name,
        primary_location: normalizedPlace,
        source: "Bocha",
        site: "zhihu.com,mafengwo.cn,mafengwo.com",
        results,
        guide_search_url: guideSearchUrl,
        total_candidates: totalCandidates,
        used_fallback_other_sources: false,
        has_other_sources: false,
        used_weak_match_fallback: usedWeakMatchFallback,
        planned_queries: plannedQueries,
        rate_limited: rateLimited,
        raw_search_results: rawSearchResults,
    });
}
//# sourceMappingURL=searchXiaohongshu.js.map