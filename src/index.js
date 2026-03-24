import { createServer } from "node:http";
import { getWeather } from "./tools/weather.js";
import { searchXiaohongshuGuideByPlace } from "./tools/searchXiaohongshu.js";
const PORT = 3000;
const apiKey = process.env.DEEPSEEK_API_KEY;
const defaultGuideSource = "Bocha";
if (!apiKey) {
    console.error("DEEPSEEK_API_KEY environment variable not set");
    process.exit(1);
}
async function callDeepSeek(messages, tools) {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: "deepseek-chat",
            messages,
            tools,
        }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DeepSeek API error ${response.status}: ${errorText}`);
    }
    return response.json();
}
function toHighlights(snippet) {
    const chunks = snippet
        .split(/[。！？!?；;]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    return chunks.slice(0, 3);
}
function dedupePlaces(drafts) {
    const seen = new Set();
    const result = [];
    for (const item of drafts) {
        if (seen.has(item.name)) {
            continue;
        }
        seen.add(item.name);
        result.push(item);
    }
    return result;
}
function toGuideSummary(snippet) {
    const clean = snippet.trim();
    if (!clean) {
        return "该笔记摘要信息较少，请打开来源链接查看完整攻略。";
    }
    return clean;
}
async function buildRoutePlan(toolOutput, query) {
    const data = JSON.parse(toolOutput);
    const guideCandidates = (Array.isArray(data.results) ? data.results : [])
        .filter((item) => item.source_type === "zhihu" || item.source_type === "mafengwo")
        .slice(0, 8);
    const primaryLocation = (data.primary_location ?? "").trim();
    const fallbackCandidates = (Array.isArray(data.raw_search_results) ? data.raw_search_results : [])
        .filter((item) => item.is_target_site === true)
        .filter((item) => item.site_platform === "zhihu" || item.site_platform === "mafengwo")
        .sort((a, b) => Number(b.relevance_score ?? 0) - Number(a.relevance_score ?? 0))
        .slice(0, 8);
    const candidatesForLLM = guideCandidates.length > 0 ? guideCandidates : fallbackCandidates;
    function safeJsonParse(text) {
        const trimmed = text.trim();
        try {
            return JSON.parse(trimmed);
        }
        catch {
            // Try strip markdown code fences and re-parse.
            const fenceStripped = trimmed
                .replace(/^```[a-zA-Z0-9_-]*\s*/g, "")
                .replace(/```$/g, "")
                .trim();
            try {
                return JSON.parse(fenceStripped);
            }
            catch {
                const start = fenceStripped.indexOf("{");
                const end = fenceStripped.lastIndexOf("}");
                if (start >= 0 && end >= 0 && end > start) {
                    try {
                        return JSON.parse(fenceStripped.slice(start, end + 1));
                    }
                    catch {
                        return null;
                    }
                }
                return null;
            }
        }
    }
    const llmCandidatesPayload = candidatesForLLM.map((item) => {
        const title = (item.title ?? "").trim();
        const snippet = (item.snippet ?? "").trim();
        const url = (item.url ?? "").trim();
        const sourceType = item.source_type === "zhihu" || item.source_type === "mafengwo"
            ? item.source_type
            : item.site_platform === "zhihu" || item.site_platform === "mafengwo"
                ? item.site_platform
                : "zhihu";
        return {
            title,
            snippet: snippet.slice(0, 500),
            url,
            siteName: (item.site_name ?? "").trim() ||
                (sourceType === "zhihu" ? "知乎" : "马蜂窝"),
            publishedAt: (item.published_at ?? "").trim(),
            sourceType,
        };
    });
    const extractionMessages = [
        {
            role: "system",
            content: "你是旅行规划助手。请从每条候选攻略结果中抽取该攻略真正提到的地名（城市/区/街道/景点/商圈/步行街等）。必须只输出 JSON，不要输出任何解释文本。",
        },
        {
            role: "user",
            content: JSON.stringify({
                query,
                primary_location: primaryLocation,
                candidates: llmCandidatesPayload,
                output: {
                    routes: [
                        {
                            candidate_index: 0,
                            places: [
                                {
                                    name: "地名",
                                    evidence: "能支撑地名的简短摘录（可为空但不建议为空）",
                                },
                            ],
                        },
                    ],
                    constraints: [
                        "routes 的每一项必须对应一个 candidate_index",
                        "如果候选文本出现 Day1/Day2/Day3（或 第一天/第二天/第三天）等日程信息，必须尽量完整提取所有天的地点，不要只返回某一天",
                        "每个 place 尽量包含 day 字段（数字，从 1 开始）",
                        "每条攻略 places 数量优先 4-12 个，按完整行程顺序排列",
                        "name 必须是明确地名，避免抽象词/泛称",
                        "去重：同一条攻略里重复地名只保留一个",
                        "如果某条攻略无法抽取出地名，places 设为空数组",
                    ],
                },
            }, null, 0),
        },
    ];
    const llmResp = await callDeepSeek(extractionMessages);
    const llmContent = llmResp.choices?.[0]?.message?.content ?? "";
    const parsed = safeJsonParse(llmContent);
    const llmRoutes = Array.isArray(parsed?.routes) ? parsed.routes : [];
    const nowIso = new Date().toISOString();
    const totalCandidates = Number(data.total_candidates ?? 0);
    const guideSearchUrl = typeof data.guide_search_url === "string" ? data.guide_search_url : undefined;
    const routeByIndex = new Map();
    for (const r of llmRoutes) {
        if (typeof r.candidate_index !== "number")
            continue;
        if (!Array.isArray(r.places))
            continue;
        routeByIndex.set(r.candidate_index, r);
    }
    const rawSearchResults = Array.isArray(data.raw_search_results) ? data.raw_search_results : [];
    const routes = [];
    for (let idx = 0; idx < candidatesForLLM.length; idx += 1) {
        const candidate = candidatesForLLM[idx];
        if (!candidate)
            continue;
        const sourceType = candidate.source_type === "zhihu" || candidate.source_type === "mafengwo"
            ? candidate.source_type
            : candidate.site_platform === "zhihu" || candidate.site_platform === "mafengwo"
                ? candidate.site_platform
                : "zhihu";
        const siteName = (candidate.site_name ?? "").trim() || (sourceType === "zhihu" ? "知乎" : "马蜂窝");
        const url = (candidate.url ?? "").trim();
        const publishedAt = (candidate.published_at ?? "").trim();
        const candidateSnippet = (candidate.snippet ?? "").trim();
        const candidateUrl = url;
        const llmRoute = routeByIndex.get(idx);
        const rawPlaces = Array.isArray(llmRoute?.places) ? llmRoute.places : [];
        const normalizedDrafts = dedupePlaces(rawPlaces
            .map((p, placeIndex) => ({
            name: (p.name ?? "").trim(),
            snippet: (p.evidence ?? "").trim() || candidateSnippet,
            url,
            siteName,
            publishedAt,
            sourceType,
            day: typeof p.day === "number" && Number.isFinite(p.day) && p.day >= 1
                ? Math.floor(p.day)
                : undefined,
            placeIndex,
        }))
            .filter((d) => d.name.length >= 2)
            .filter((d) => d.url.length > 0)
            .slice(0, 16))
            .sort((a, b) => {
            const ad = a.day ?? Number.MAX_SAFE_INTEGER;
            const bd = b.day ?? Number.MAX_SAFE_INTEGER;
            if (ad !== bd)
                return ad - bd;
            return a.placeIndex - b.placeIndex;
        })
            .slice(0, 12);
        const places = normalizedDrafts.map((draft, pIdx) => {
            const summary = toGuideSummary(draft.snippet);
            const dayPrefix = typeof draft.day === "number" && draft.day >= 1 ? `Day${draft.day}:` : "";
            const normalizedSummary = dayPrefix && !summary.toLowerCase().includes(`day${draft.day}`)
                ? `${dayPrefix}${summary}`
                : summary;
            return {
                place_id: `place_${pIdx + 1}`,
                order: pIdx + 1,
                ...(typeof draft.day === "number" && draft.day >= 1 ? { day: draft.day } : {}),
                name: draft.name,
                guide: {
                    summary: normalizedSummary,
                    highlights: toHighlights(normalizedSummary),
                },
            };
        });
        const segments = [];
        for (let i = 0; i < places.length - 1; i += 1) {
            const from = places[i];
            const to = places[i + 1];
            if (!from || !to)
                continue;
            segments.push({
                segment_id: `segment_${i + 1}`,
                order: i + 1,
                from_place_id: from.place_id,
                to_place_id: to.place_id,
                transport: {
                    mode: "地铁优先，必要时打车",
                    duration_estimate: "30-60分钟（按实时路况调整）",
                },
                guide: {
                    strategy: `建议先游览「${from.name}」，再前往「${to.name}」，避免折返。`,
                    references: [candidateUrl].filter((u) => u.length > 0),
                },
            });
        }
        const routeMetadata = {
            result_count: places.length,
            generated_at: nowIso,
        };
        routes.push({
            type: "route_plan",
            query,
            source: candidate.source_type ?? siteName,
            strategy: "zhihu_mafengwo_only",
            overview: places.length > 0
                ? "已根据该条攻略生成路线，请按 places 顺序游览，并参考 segments 的路径建议。"
                : "该攻略未能抽取到明确地名。",
            places,
            segments,
            metadata: routeMetadata,
            ...(candidate.title ? { note: `来源攻略：${candidate.title}` } : {}),
            original: {
                ...(candidate.title ? { title: candidate.title } : {}),
                ...(candidate.url ? { url: candidate.url } : {}),
                ...(candidateSnippet ? { snippet: candidateSnippet } : {}),
                ...(candidate.site_name ? { site_name: candidate.site_name } : {}),
                ...(candidate.published_at ? { published_at: candidate.published_at } : {}),
                ...(candidate.source_type ? { source_type: candidate.source_type } : {}),
                ...(candidate.site_platform ? { site_platform: candidate.site_platform } : {}),
                ...(primaryLocation ? { primary_location: primaryLocation } : {}),
            },
        });
    }
    const routeCountNonEmpty = routes.filter((r) => r.places.length > 0).length;
    const batch = {
        type: "route_plan_batch",
        query,
        source: data.source ?? defaultGuideSource,
        strategy: "zhihu_mafengwo_only",
        overview: routeCountNonEmpty > 0 ? "已为每条攻略生成独立路线。" : "未能从攻略中抽取到可用地名。",
        routes,
        metadata: {
            total_candidates: totalCandidates,
            route_count: routes.length,
            generated_at: nowIso,
            ...(guideSearchUrl ? { guide_search_url: guideSearchUrl } : {}),
        },
    };
    if (routes.every((r) => r.places.length === 0)) {
        if (data.rate_limited) {
            batch.note = "攻略检索触发 Bocha 限流（429），请稍后重试。";
        }
        else if (candidatesForLLM.length > 0) {
            batch.note = "已检索到知乎/马蜂窝结果，但未提取到明确地名。建议换更具体主地点重试。";
        }
        else {
            batch.note = "没有检索到知乎或马蜂窝站点的可用攻略结果。";
        }
    }
    return batch;
}
function buildGuideFailure(userPrompt, message) {
    return {
        type: "route_plan_batch",
        query: userPrompt,
        source: defaultGuideSource,
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
async function runGuideChatWithTool(userPrompt) {
    const tools = [
        {
            type: "function",
            function: {
                name: "search_travel_guide",
                description: "Search travel guides from Zhihu and Mafengwo for one destination. This tool REQUIRES a place_name.",
                parameters: {
                    type: "object",
                    properties: {
                        place_name: {
                            type: "string",
                            description: "Required place name for travel guide search. Must be a geographic location such as city, district, or street (e.g. 深圳, 南山区, 东门老街).",
                        },
                    },
                    required: ["place_name"],
                },
            },
        },
    ];
    const messages = [
        {
            role: "system",
            content: "当用户要旅游攻略时，你必须从当前对话中提取地名并调用 search_travel_guide。该工具会检索知乎和马蜂窝，必须提供 place_name，且 place_name 必须是地名（城市/区/街道/景区名）。如果无法识别地名，不要猜测，直接返回需要补充地名。",
        },
        { role: "user", content: userPrompt },
    ];
    try {
        const completion = await callDeepSeek(messages, tools);
        const assistantMessage = completion.choices?.[0]?.message;
        const rawToolCalls = assistantMessage?.tool_calls;
        const toolCalls = Array.isArray(rawToolCalls)
            ? rawToolCalls
            : [];
        const guideToolCall = toolCalls.find((call) => call.function?.name === "search_travel_guide");
        if (!guideToolCall) {
            return buildGuideFailure(userPrompt, "缺少主地点，请在问题中明确地名（城市、区或街道），例如：上海静安区旅游攻略。");
        }
        const argsText = guideToolCall.function?.arguments ?? "{}";
        const args = JSON.parse(argsText);
        const placeName = typeof args.place_name === "string" ? args.place_name.trim() : "";
        if (!placeName) {
            return buildGuideFailure(userPrompt, "缺少主地点，请在请求里带上城市、区或街道，例如：深圳南山区旅游攻略。");
        }
        const toolOutput = await searchXiaohongshuGuideByPlace({
            place_name: placeName,
            max_results: 8,
            original_query: userPrompt,
        });
        return await buildRoutePlan(toolOutput, userPrompt);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return buildGuideFailure(userPrompt, message);
    }
}
async function runChat(userPrompt) {
    if (isGuideQuery(userPrompt)) {
        return runGuideChatWithTool(userPrompt);
    }
    const tools = [
        {
            type: "function",
            function: {
                name: "get_weather",
                description: "Get 3-day weather by QWeather location ID. You should provide both city and location_id (e.g. Beijing => 101010100, Shanghai => 101020100).",
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
        },
    ];
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
    const args = JSON.parse(toolCall.function.arguments ?? "{}");
    const weather = await getWeather({
        city: typeof args.city === "string" ? args.city : undefined,
        locationId: String(args.location_id ?? ""),
    });
    const followUpMessages = [
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
function isGuideQuery(prompt) {
    const text = prompt.toLowerCase();
    const keywords = [
        "攻略",
        "旅行",
        "旅游",
        "行程",
        "景点",
        "打卡",
        "itinerary",
        "travel guide",
        "route",
        "plan",
    ];
    return keywords.some((keyword) => text.includes(keyword));
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
        });
        req.on("end", () => {
            if (!data) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(data));
            }
            catch {
                reject(new Error("Invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}
const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.end(JSON.stringify({ status: "ok" }));
        return;
    }
    if (req.method === "POST" && req.url === "/chat") {
        try {
            const body = await readJsonBody(req);
            const prompt = body.message?.trim() || "What's the weather like in Shanghai, China?";
            const answer = await runChat(prompt);
            res.statusCode = 200;
            if (typeof answer === "string") {
                res.end(JSON.stringify({ reply: answer }));
            }
            else {
                res.end(JSON.stringify(answer));
            }
        }
        catch (error) {
            res.statusCode = 400;
            res.end(JSON.stringify({
                error: error instanceof Error ? error.message : "Unknown error",
            }));
        }
        return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
});
server.on("error", (err) => {
    const code = err?.code;
    if (code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use, stopping.`);
        process.exit(1);
    }
    throw err;
});
server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
});
//# sourceMappingURL=index.js.map