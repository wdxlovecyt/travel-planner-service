import type { z } from "zod";
import type { guideRequestSchema, routePlanRequestSchema } from "./schemas";

export type RoutePlanRequestBody = z.infer<typeof routePlanRequestSchema>;
export type GuideRequestBody = z.infer<typeof guideRequestSchema>;
