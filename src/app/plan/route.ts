import { runPlan } from "../../planner/runPlan";
import { errorResponse, jsonResponse } from "../../server/response";
import { planRequestSchema } from "../../server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = planRequestSchema.parse(await req.json());
    const prompt = body.message;
    const answer = await runPlan(prompt);
    return jsonResponse(typeof answer === "string" ? { reply: answer } : answer);
  } catch (error) {
    return errorResponse(error);
  }
}
