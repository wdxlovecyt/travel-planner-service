export type RoutePlanningMode = "walking" | "driving" | "transit" | "riding";

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
  mode?: RoutePlanningMode;
};

export type GeocodeResult = {
  formatted_address?: string;
  city?: string | string[];
  district?: string;
  adcode?: string;
  location?: string;
};

export type RoutePlanningPoint = {
  name: string;
  location: string;
  formatted_address?: string;
  city?: string;
  district?: string;
  adcode?: string;
};

export type RawStep = {
  instruction?: string;
  orientation?: string;
  road?: string | string[];
  distance?: string | number;
  duration?: string | number;
  polyline?: string;
  action?: string;
  assistant_action?: string;
};

export type RawPath = {
  distance?: string | number;
  duration?: string | number;
  polyline?: string;
  steps?: RawStep[];
  traffic_lights?: string | number;
  tolls?: string | number;
  cost?: string | number;
};

export type RawStop = {
  id?: string;
  name?: string;
  location?: string;
  adcode?: string;
  time?: string;
  start?: string | number;
  end?: string | number;
};

export type RawBusLine = {
  id?: string;
  name?: string;
  type?: string;
  distance?: string | number;
  duration?: string | number;
  polyline?: string;
  start_time?: string;
  end_time?: string;
  departure_stop?: RawStop;
  arrival_stop?: RawStop;
  via_num?: string | number;
  via_stops?: RawStop[];
};

export type RawRailway = {
  id?: string;
  name?: string;
  trip?: string;
  type?: string;
  time?: string | number;
  distance?: string | number;
  departure_stop?: RawStop;
  arrival_stop?: RawStop;
  via_stop?: RawStop[];
  alters?: Array<{
    id?: string;
    name?: string;
  }>;
};

export type RawTransitSegment = {
  walking?: {
    distance?: string | number;
    duration?: string | number;
    origin?: string;
    destination?: string;
    steps?: RawStep[];
  } | [];
  bus?: {
    buslines?: RawBusLine[];
  } | [];
  railway?: RawRailway | [];
  taxi?: {
    price?: string | number;
    distance?: string | number;
    drivetime?: string | number;
    duration?: string | number;
    polyline?: string;
  } | [];
};

export type RawTransit = {
  cost?: string | number;
  duration?: string | number;
  walking_distance?: string | number;
  distance?: string | number;
  nightflag?: string | number;
  segments?: RawTransitSegment[];
};

export type RoutePlanningLocation = {
  name: string;
  location: string;
  formatted_address?: string;
  city?: string;
  district?: string;
  adcode?: string;
};

export type RoutePlanStep = {
  instruction?: string;
  road?: string;
  orientation?: string;
  action?: string;
  assistant_action?: string;
  distance_m?: number;
  duration_s?: number;
};

export type RoutePlanStop = {
  id?: string;
  name?: string;
  location?: string;
  adcode?: string;
  time?: string;
  is_start?: boolean;
  is_end?: boolean;
};

export type RoutePlanLine = {
  id?: string;
  name?: string;
  type?: string;
  direction?: string;
  start_time?: string;
  end_time?: string;
  trip?: string;
};

export type RoutePlanLegType =
  | "walking"
  | "driving"
  | "riding"
  | "bus"
  | "subway"
  | "railway"
  | "taxi";

export type RoutePlanLeg = {
  type: RoutePlanLegType;
  instruction?: string;
  distance_m?: number;
  duration_s?: number;
  polyline?: string;
  steps: RoutePlanStep[];
  line?: RoutePlanLine;
  departure_stop?: RoutePlanStop;
  arrival_stop?: RoutePlanStop;
  via_stops: RoutePlanStop[];
  via_stop_count?: number;
  cost?: number;
  traffic_lights?: number;
};

export type RoutePlanSummary = {
  distance_m?: number;
  duration_s?: number;
  cost?: number;
  taxi_cost?: number;
  walking_distance_m?: number;
  transfers?: number;
  traffic_lights?: number;
  night_bus?: boolean;
};

export type RoutePlan = {
  mode: RoutePlanningMode;
  origin: RoutePlanningLocation;
  destination: RoutePlanningLocation;
  summary: RoutePlanSummary;
  legs: RoutePlanLeg[];
};

export type PlannedSegment = {
  segment_id?: string;
  order?: number;
  from_place_id?: string;
  to_place_id?: string;
  from_place_name: string;
  to_place_name: string;
  route_plan?: RoutePlan;
  error?: string;
};

export type SegmentRoutePlanningResponse = {
  type: "segment_route_plan_batch";
  city?: string;
  metadata: {
    segment_count: number;
    planned_count: number;
    generated_at: string;
  };
  segments: PlannedSegment[];
};
