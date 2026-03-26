type RoutePlanningMode = "walking";

export type RoutePlanningSegmentInput = {
  segment_id?: string;
  order?: number;
  from_place_id?: string;
  to_place_id?: string;
  from_place_name?: string;
  to_place_name?: string;
  from_location?: string;
  to_location?: string;
  city?: string;
};

type GeocodeResult = {
  formatted_address?: string;
  country?: string;
  province?: string;
  city?: string | string[];
  district?: string;
  adcode?: string;
  location?: string;
};

type WalkingStep = {
  instruction?: string;
  orientation?: string;
  road?: string;
  distance?: string;
  duration?: string;
  polyline?: string;
  action?: string;
  assistant_action?: string;
};

type WalkingPath = {
  distance?: string;
  duration?: string;
  steps?: WalkingStep[];
};

type RoutePlanStep = {
  instruction?: string;
  road?: string;
  orientation?: string;
  action?: string;
  assistant_action?: string;
  distance_m?: number;
  duration_s?: number;
  polyline?: string;
};

type PlannedSegment = {
  segment_id?: string;
  order?: number;
  from_place_id?: string;
  to_place_id?: string;
  from_place_name: string;
  to_place_name: string;
  route_plan?: {
    mode: RoutePlanningMode;
    origin: {
      name: string;
      location: string;
      formatted_address?: string;
      city?: string;
      district?: string;
      adcode?: string;
    };
    destination: {
      name: string;
      location: string;
      formatted_address?: string;
      city?: string;
      district?: string;
      adcode?: string;
    };
    distance_m?: number;
    duration_s?: number;
    steps: RoutePlanStep[];
    polyline?: string;
  };
  error?: string;
};

export type SegmentRoutePlanningResponse = {
  type: "segment_route_plan_batch";
  mode: RoutePlanningMode;
  city?: string;
  metadata: {
    segment_count: number;
    planned_count: number;
    generated_at: string;
  };
  segments: PlannedSegment[];
};

const amapApiKey = process.env.AMAP_API_KEY ?? "dc9aa3d1e4a5e0572264f520753ea633";
const amapApiBaseUrl = (process.env.AMAP_API_BASE_URL ?? "https://restapi.amap.com").replace(
  /\/+$/,
  "",
);

function withOptionalFields<T extends object>(base: T, extras: Record<string, unknown>) {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== undefined)),
  };
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined;
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

function isLngLat(value: string | undefined) {
  if (!value) return false;
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value.trim());
}

async function callAmap(pathname: string, params: Record<string, string | undefined>) {
  if (!amapApiKey) {
    throw new Error("AMAP_API_KEY is missing");
  }

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
  if (String(data?.status) !== "1") {
    throw new Error(`Amap API error: ${String(data?.info ?? "unknown error")}`);
  }

  return data;
}

async function geocodePlace(name: string, city?: string) {
  const data = await callAmap("/v3/geocode/geo", {
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
  );
}

async function getWalkingRoute(origin: string, destination: string) {
  const data = await callAmap("/v3/direction/walking", {
    origin,
    destination,
  });

  const path = (Array.isArray(data?.route?.paths) ? data.route.paths[0] : undefined) as
    | WalkingPath
    | undefined;
  if (!path) {
    throw new Error("Failed to get walking route");
  }

  const steps = (Array.isArray(path.steps) ? path.steps : []).map((step) =>
    withOptionalFields(
      {},
      {
        instruction: toOptionalString(step.instruction),
        road: toOptionalString(step.road),
        orientation: toOptionalString(step.orientation),
        action: toOptionalString(step.action),
        assistant_action: toOptionalString(step.assistant_action),
        distance_m: parseNumber(step.distance),
        duration_s: parseNumber(step.duration),
        polyline: toOptionalString(step.polyline),
      },
    ) as RoutePlanStep,
  );

  const polyline = steps
    .map((step) => step.polyline)
    .filter((value): value is string => Boolean(value))
    .join(";");

  return {
    distance_m: parseNumber(path.distance),
    duration_s: parseNumber(path.duration),
    steps,
    ...(polyline ? { polyline } : {}),
  };
}

async function resolvePoint(name: string, location: string | undefined, city: string | undefined) {
  const normalizedLocation = toOptionalString(location);
  if (normalizedLocation && isLngLat(normalizedLocation)) {
    return {
      name,
      location: normalizedLocation,
    };
  }
  return geocodePlace(name, city);
}

export async function planSegmentRoutes(input: {
  segments: RoutePlanningSegmentInput[];
  city?: string;
  mode?: RoutePlanningMode;
}): Promise<SegmentRoutePlanningResponse> {
  const mode: RoutePlanningMode = input.mode ?? "walking";
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const city = toOptionalString(input.city);
  const pointCache = new Map<string, Promise<Awaited<ReturnType<typeof resolvePoint>>>>();

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

  const plannedSegments = await Promise.all(
    segments.map(async (segment) => {
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

        const routePlan = await getWalkingRoute(origin.location, destination.location);
        return withOptionalFields(
          {
            from_place_name: fromPlaceName,
            to_place_name: toPlaceName,
            route_plan: withOptionalFields(
              {
                mode,
                origin,
                destination,
                steps: routePlan.steps,
              },
              {
                distance_m: routePlan.distance_m,
                duration_s: routePlan.duration_s,
                polyline: routePlan.polyline,
              },
            ),
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
    }),
  );

  return {
    type: "segment_route_plan_batch",
    mode,
    ...(city ? { city } : {}),
    metadata: {
      segment_count: segments.length,
      planned_count: plannedSegments.filter((segment) => segment.route_plan).length,
      generated_at: new Date().toISOString(),
    },
    segments: plannedSegments,
  };
}
