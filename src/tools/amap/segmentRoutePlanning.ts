import type {
  GeocodeResult,
  PlannedSegment,
  RawBusLine,
  RawPath,
  RawRailway,
  RawStep,
  RawStop,
  RawTransit,
  RawTransitSegment,
  RoutePlan,
  RoutePlanLeg,
  RoutePlanLegType,
  RoutePlanLine,
  RoutePlanStep,
  RoutePlanStop,
  RoutePlanSummary,
  RoutePlanningLocation,
  RoutePlanningMode,
  RoutePlanningPoint,
  RoutePlanningSegmentInput,
  SegmentRoutePlanningResponse,
} from "./types";

const amapApiKey = process.env.AMAP_API_KEY ?? "dc9aa3d1e4a5e0572264f520753ea633";
const amapApiBaseUrl = (process.env.AMAP_API_BASE_URL ?? "https://restapi.amap.com").replace(
  /\/+$/,
  "",
);
const amapMaxConcurrency = Math.max(Number(process.env.AMAP_MAX_CONCURRENCY ?? 5), 1);

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withOptionalFields<T extends object>(base: T, extras: Record<string, unknown>) {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== undefined)),
  };
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseNumber(value: string | number | undefined) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeCity(value: string | string[] | undefined) {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim().length > 0);
    return first?.trim() || undefined;
  }
  return undefined;
}

function normalizeRoad(value: string | string[] | undefined) {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join("/");
    return joined || undefined;
  }
  return undefined;
}

function isLngLat(value: string | undefined) {
  if (!value) return false;
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value.trim());
}

function buildRoutePolyline(parts: Array<string | undefined>) {
  const merged = parts.filter((value): value is string => Boolean(value)).join(";");
  return merged || undefined;
}

function mapStep(step: RawStep): RoutePlanStep {
  return withOptionalFields(
    {},
    {
      instruction: toOptionalString(step.instruction),
      road: normalizeRoad(step.road),
      orientation: toOptionalString(step.orientation),
      action: toOptionalString(step.action),
      assistant_action: toOptionalString(step.assistant_action),
      distance_m: parseNumber(step.distance),
      duration_s: parseNumber(step.duration),
    },
  ) as RoutePlanStep;
}

function mapSteps(steps: RawStep[] | undefined) {
  return (Array.isArray(steps) ? steps : []).map(mapStep);
}

function mapStop(stop: RawStop | undefined): RoutePlanStop | undefined {
  if (!stop || typeof stop !== "object") {
    return undefined;
  }
  return withOptionalFields(
    {},
    {
      id: toOptionalString(stop.id),
      name: toOptionalString(stop.name),
      location: toOptionalString(stop.location),
      adcode: toOptionalString(stop.adcode),
      time: toOptionalString(stop.time),
      is_start: String(stop.start) === "1" ? true : undefined,
      is_end: String(stop.end) === "1" ? true : undefined,
    },
  ) as RoutePlanStop;
}

function mapStops(stops: RawStop[] | undefined) {
  return (Array.isArray(stops) ? stops : [])
    .map(mapStop)
    .filter((stop): stop is RoutePlanStop => Boolean(stop));
}

function lineTypeToLegType(value: string | undefined): RoutePlanLegType {
  const normalized = value ?? "";
  if (normalized.includes("地铁")) {
    return "subway";
  }
  if (normalized.includes("火车") || normalized.includes("铁路") || normalized.includes("高铁")) {
    return "railway";
  }
  return "bus";
}

async function callAmapV3(pathname: string, params: Record<string, string | undefined>) {
  if (!amapApiKey) {
    throw new Error("AMAP_API_KEY is missing");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = new URL(pathname, amapApiBaseUrl);
    url.searchParams.set("key", amapApiKey);
    url.searchParams.set("output", "json");

    for (const [key, value] of Object.entries(params)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Amap request failed ${response.status}: ${details}`);
    }

    const data = await response.json();
    if (String(data?.status) === "1") {
      return data;
    }

    const info = String(data?.info ?? "unknown error");
    const isQpsLimited = info.includes("CUQPS_HAS_EXCEEDED_THE_LIMIT");
    if (!isQpsLimited || attempt === 2) {
      throw new Error(`Amap API error: ${info}`);
    }

    await sleep(300 * (attempt + 1));
  }

  throw new Error("Amap API error: unknown error");
}

async function callAmapV4(pathname: string, params: Record<string, string | undefined>) {
  if (!amapApiKey) {
    throw new Error("AMAP_API_KEY is missing");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = new URL(pathname, amapApiBaseUrl);
    url.searchParams.set("key", amapApiKey);

    for (const [key, value] of Object.entries(params)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Amap request failed ${response.status}: ${details}`);
    }

    const data = await response.json();
    const errcode = Number(data?.errcode ?? 0);
    if ((errcode === 0 || Number.isNaN(errcode)) && data?.data) {
      return data;
    }

    const info = String(data?.errmsg ?? data?.errdetail ?? "unknown error");
    const isQpsLimited = info.includes("CUQPS_HAS_EXCEEDED_THE_LIMIT");
    if (!isQpsLimited || attempt === 2) {
      throw new Error(`Amap API error: ${info}`);
    }

    await sleep(300 * (attempt + 1));
  }

  throw new Error("Amap API error: unknown error");
}

async function geocodePlace(name: string, city?: string) {
  const data = await callAmapV3("/v3/geocode/geo", {
    address: name,
    city,
  });

  const geocode = (Array.isArray(data?.geocodes) ? data.geocodes[0] : undefined) as
    | GeocodeResult
    | undefined;
  const location = toOptionalString(geocode?.location);
  if (!location) {
    throw new Error(`Failed to geocode place: ${name}`);
  }

  return withOptionalFields(
    {
      name,
      location,
    },
    {
      formatted_address: toOptionalString(geocode?.formatted_address),
      city: normalizeCity(geocode?.city),
      district: toOptionalString(geocode?.district),
      adcode: toOptionalString(geocode?.adcode),
    },
  ) as RoutePlanningPoint;
}

function buildSingleLegRoutePlan(
  mode: RoutePlanningMode,
  origin: RoutePlanningLocation,
  destination: RoutePlanningLocation,
  path: RawPath,
): RoutePlan {
  const steps = mapSteps(path.steps);
  const polyline = buildRoutePolyline([
    ...(Array.isArray(path.steps) ? path.steps.map((step) => toOptionalString(step.polyline)) : []),
    toOptionalString(path.polyline),
  ]);
  const summary: RoutePlanSummary = withOptionalFields(
    {},
    {
      distance_m: parseNumber(path.distance),
      duration_s: parseNumber(path.duration),
      cost: parseNumber(path.cost),
      traffic_lights: parseNumber(path.traffic_lights),
    },
  );

  const leg = withOptionalFields(
    {
      type: mode,
      steps,
      via_stops: [],
    },
    {
      instruction: steps[0]?.instruction,
      distance_m: parseNumber(path.distance),
      duration_s: parseNumber(path.duration),
      polyline,
      cost: parseNumber(path.cost),
      traffic_lights: parseNumber(path.traffic_lights),
    },
  ) as RoutePlanLeg;

  return {
    mode,
    origin,
    destination,
    summary,
    legs: [leg],
  };
}

async function getWalkingRoutePlan(origin: RoutePlanningLocation, destination: RoutePlanningLocation) {
  const data = await callAmapV3("/v3/direction/walking", {
    origin: origin.location,
    destination: destination.location,
  });

  const path = (Array.isArray(data?.route?.paths) ? data.route.paths[0] : undefined) as
    | RawPath
    | undefined;
  if (!path) {
    throw new Error("Failed to get walking route");
  }

  return buildSingleLegRoutePlan("walking", origin, destination, path);
}

async function getDrivingRoutePlan(origin: RoutePlanningLocation, destination: RoutePlanningLocation) {
  const data = await callAmapV3("/v3/direction/driving", {
    origin: origin.location,
    destination: destination.location,
    extensions: "all",
  });

  const path = (Array.isArray(data?.route?.paths) ? data.route.paths[0] : undefined) as
    | RawPath
    | undefined;
  if (!path) {
    throw new Error("Failed to get driving route");
  }

  return buildSingleLegRoutePlan("driving", origin, destination, path);
}

async function getRidingRoutePlan(origin: RoutePlanningLocation, destination: RoutePlanningLocation) {
  const data = await callAmapV4("/v4/direction/bicycling", {
    origin: origin.location,
    destination: destination.location,
  });

  const path = (Array.isArray(data?.data?.paths) ? data.data.paths[0] : undefined) as
    | RawPath
    | undefined;
  if (!path) {
    throw new Error("Failed to get riding route");
  }

  return buildSingleLegRoutePlan("riding", origin, destination, path);
}

function mapWalkingLeg(walking: RawTransitSegment["walking"]): RoutePlanLeg | undefined {
  if (!walking || Array.isArray(walking)) {
    return undefined;
  }

  const steps = mapSteps(walking.steps);
  const distance = parseNumber(walking.distance);
  const duration = parseNumber(walking.duration);
  const polyline = buildRoutePolyline(
    Array.isArray(walking.steps) ? walking.steps.map((step) => toOptionalString(step.polyline)) : [],
  );
  if (!distance && !duration && steps.length === 0) {
    return undefined;
  }

  return withOptionalFields(
    {
      type: "walking",
      steps,
      via_stops: [],
    },
    {
      instruction: steps[0]?.instruction,
      distance_m: distance,
      duration_s: duration,
      polyline,
    },
  ) as RoutePlanLeg;
}

function mapBusLegs(bus: RawTransitSegment["bus"]): RoutePlanLeg[] {
  if (!bus || Array.isArray(bus)) {
    return [];
  }

  const lines = Array.isArray(bus.buslines) ? bus.buslines : [];
  return lines.map((line) => {
    const legType = lineTypeToLegType(toOptionalString(line.type));
    const lineName = toOptionalString(line.name);
    const polyline = toOptionalString(line.polyline);
    return withOptionalFields(
      {
        type: legType,
        steps: [],
        via_stops: mapStops(line.via_stops),
      },
      {
        instruction: lineName,
        distance_m: parseNumber(line.distance),
        duration_s: parseNumber(line.duration),
        polyline,
        line: withOptionalFields(
          {},
          {
            id: toOptionalString(line.id),
            name: lineName,
            type: toOptionalString(line.type),
            start_time: toOptionalString(line.start_time),
            end_time: toOptionalString(line.end_time),
          },
        ),
        departure_stop: mapStop(line.departure_stop),
        arrival_stop: mapStop(line.arrival_stop),
        via_stop_count: parseNumber(line.via_num),
      },
    ) as RoutePlanLeg;
  });
}

function mapRailwayLeg(railway: RawTransitSegment["railway"]): RoutePlanLeg | undefined {
  if (!railway || Array.isArray(railway)) {
    return undefined;
  }

  const distance = parseNumber(railway.distance);
  const duration = parseNumber(railway.time);
  if (!distance && !duration && !railway.name) {
    return undefined;
  }

  return withOptionalFields(
    {
      type: "railway",
      steps: [],
      via_stops: mapStops(railway.via_stop),
    },
    {
      instruction: toOptionalString(railway.name),
      distance_m: distance,
      duration_s: duration,
      line: withOptionalFields(
        {},
        {
          id: toOptionalString(railway.id),
          name: toOptionalString(railway.name),
          type: toOptionalString(railway.type),
          trip: toOptionalString(railway.trip),
        },
      ),
      departure_stop: mapStop(railway.departure_stop),
      arrival_stop: mapStop(railway.arrival_stop),
      via_stop_count: Array.isArray(railway.via_stop) ? railway.via_stop.length : undefined,
    },
  ) as RoutePlanLeg;
}

function mapTaxiLeg(taxi: RawTransitSegment["taxi"]): RoutePlanLeg | undefined {
  if (!taxi || Array.isArray(taxi)) {
    return undefined;
  }

  const distance = parseNumber(taxi.distance);
  const duration = parseNumber(taxi.drivetime) ?? parseNumber(taxi.duration);
  const cost = parseNumber(taxi.price);
  if (!distance && !duration && cost === undefined) {
    return undefined;
  }

  return withOptionalFields(
    {
      type: "taxi",
      steps: [],
      via_stops: [],
    },
    {
      instruction: "taxi",
      distance_m: distance,
      duration_s: duration,
      polyline: toOptionalString(taxi.polyline),
      cost,
    },
  ) as RoutePlanLeg;
}

async function getTransitRoutePlan(
  origin: RoutePlanningLocation,
  destination: RoutePlanningLocation,
  city: string | undefined,
) {
  const resolvedCity = city ?? origin.city ?? destination.city;
  if (!resolvedCity) {
    throw new Error("city is required for transit mode");
  }

  const data = await callAmapV3("/v3/direction/transit/integrated", {
    origin: origin.location,
    destination: destination.location,
    city: resolvedCity,
    extensions: "all",
  });

  const transit = (Array.isArray(data?.route?.transits) ? data.route.transits[0] : undefined) as
    | RawTransit
    | undefined;
  if (!transit) {
    throw new Error("Failed to get transit route");
  }

  const rawSegments = Array.isArray(transit.segments) ? transit.segments : [];
  const legs: RoutePlanLeg[] = [];

  for (const segment of rawSegments) {
    const walkingLeg = mapWalkingLeg(segment.walking);
    if (walkingLeg) {
      legs.push(walkingLeg);
    }

    const busLegs = mapBusLegs(segment.bus);
    if (busLegs.length > 0) {
      legs.push(...busLegs);
    }

    const railwayLeg = mapRailwayLeg(segment.railway);
    if (railwayLeg) {
      legs.push(railwayLeg);
    }

    const taxiLeg = mapTaxiLeg(segment.taxi);
    if (taxiLeg) {
      legs.push(taxiLeg);
    }
  }

  const publicTransitCount = legs.filter((leg) =>
    leg.type === "bus" || leg.type === "subway" || leg.type === "railway",
  ).length;

  return {
    mode: "transit",
    origin,
    destination,
    summary: withOptionalFields(
      {},
      {
        distance_m: parseNumber(transit.distance),
        duration_s: parseNumber(transit.duration),
        cost: parseNumber(transit.cost),
        taxi_cost: parseNumber(data?.route?.taxi_cost),
        walking_distance_m: parseNumber(transit.walking_distance),
        transfers: Math.max(publicTransitCount - 1, 0),
        night_bus: String(transit.nightflag) === "1" ? true : undefined,
      },
    ) as RoutePlanSummary,
    legs,
  } satisfies RoutePlan;
}

async function getRoutePlanByMode(input: {
  mode: RoutePlanningMode;
  origin: RoutePlanningLocation;
  destination: RoutePlanningLocation;
  city?: string;
}) {
  if (input.mode === "driving") {
    return getDrivingRoutePlan(input.origin, input.destination);
  }
  if (input.mode === "riding") {
    return getRidingRoutePlan(input.origin, input.destination);
  }
  if (input.mode === "transit") {
    return getTransitRoutePlan(input.origin, input.destination, input.city);
  }
  return getWalkingRoutePlan(input.origin, input.destination);
}

async function resolvePoint(name: string, location: string | undefined, city: string | undefined) {
  const normalizedLocation = toOptionalString(location);
  if (normalizedLocation && isLngLat(normalizedLocation)) {
    return {
      name,
      location: normalizedLocation,
    } as RoutePlanningPoint;
  }
  return geocodePlace(name, city);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= items.length) {
        return;
      }

      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }
      results[currentIndex] = await worker(item, currentIndex);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => runWorker()),
  );
  return results;
}

export async function planSegmentRoutes(input: {
  segments: RoutePlanningSegmentInput[];
  city?: string;
}): Promise<SegmentRoutePlanningResponse> {
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const city = toOptionalString(input.city);
  const pointCache = new Map<string, Promise<RoutePlanningPoint>>();

  const resolvePointCached = (
    name: string,
    location: string | undefined,
    resolvedCity: string | undefined,
  ) => {
    const normalizedLocation = toOptionalString(location);
    const cacheKey = JSON.stringify({
      name,
      location: normalizedLocation ?? "",
      city: resolvedCity ?? "",
    });

    const cached = pointCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const task = resolvePoint(name, normalizedLocation, resolvedCity);
    pointCache.set(cacheKey, task);
    return task;
  };

  const plannedSegments = await mapWithConcurrency(
    segments,
    amapMaxConcurrency,
    async (segment) => {
      const fromPlaceName = toOptionalString(segment.from_place_name);
      const toPlaceName = toOptionalString(segment.to_place_name);
      if (!fromPlaceName || !toPlaceName) {
        return withOptionalFields(
          {
            from_place_name: fromPlaceName ?? "",
            to_place_name: toPlaceName ?? "",
            error: "from_place_name and to_place_name are required",
          },
          {
            segment_id: segment.segment_id,
            order: segment.order,
            from_place_id: segment.from_place_id,
            to_place_id: segment.to_place_id,
          },
        ) as PlannedSegment;
      }

      try {
        const resolvedCity = toOptionalString(segment.city) ?? city;
        const resolvedMode: RoutePlanningMode =
          segment.mode === "driving" ||
          segment.mode === "transit" ||
          segment.mode === "riding"
            ? segment.mode
            : "walking";

        const [origin, destination] = await Promise.all([
          resolvePointCached(
            fromPlaceName,
            toOptionalString(segment.from_location),
            resolvedCity,
          ),
          resolvePointCached(
            toPlaceName,
            toOptionalString(segment.to_location),
            resolvedCity,
          ),
        ]);

        const routePlan = await getRoutePlanByMode({
          mode: resolvedMode,
          origin,
          destination,
          ...(resolvedCity ? { city: resolvedCity } : {}),
        });

        return withOptionalFields(
          {
            from_place_name: fromPlaceName,
            to_place_name: toPlaceName,
            route_plan: routePlan,
          },
          {
            segment_id: segment.segment_id,
            order: segment.order,
            from_place_id: segment.from_place_id,
            to_place_id: segment.to_place_id,
          },
        ) as PlannedSegment;
      } catch (error) {
        return withOptionalFields(
          {
            from_place_name: fromPlaceName,
            to_place_name: toPlaceName,
            error: error instanceof Error ? error.message : "Unknown route planning error",
          },
          {
            segment_id: segment.segment_id,
            order: segment.order,
            from_place_id: segment.from_place_id,
            to_place_id: segment.to_place_id,
          },
        ) as PlannedSegment;
      }
    },
  );

  return {
    type: "segment_route_plan_batch",
    ...(city ? { city } : {}),
    metadata: {
      segment_count: segments.length,
      planned_count: plannedSegments.filter((segment) => segment.route_plan).length,
      generated_at: new Date().toISOString(),
    },
    segments: plannedSegments,
  };
}
