import { planSegmentRoutes } from "../../tools/amap/segmentRoutePlanning";
import { errorResponse, jsonResponse } from "../../server/response";
import { routePlanRequestSchema } from "../../server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = routePlanRequestSchema.parse(await req.json());
    const response = await planSegmentRoutes({
      segments: body.segments,
      ...(body.city ? { city: body.city } : {}),
    });
    return jsonResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
