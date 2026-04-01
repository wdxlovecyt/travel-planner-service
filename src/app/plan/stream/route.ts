import { runPlanStream, writePlanStreamError } from "../../../planner/streamPlan";
import { sseResponse } from "../../../server/response";
import { planRequestSchema } from "../../../server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return sseResponse(async (write) => {
    try {
      const body = planRequestSchema.parse(await req.json());
      const prompt = body.message;
      await runPlanStream(prompt, write);
    } catch (error) {
      await writePlanStreamError(write, error);
    }
  });
}
