import { jsonResponse } from "../../server/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return jsonResponse({ status: "ok" });
}
