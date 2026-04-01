import { runDirectGuidePlan } from "../../planner/guidePlan";
import { fileToDataUrl } from "../../server/files";
import { errorResponse, jsonResponse } from "../../server/response";
import { guideRequestSchema } from "../../server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let body;

    if (contentType.toLowerCase().startsWith("text/plain")) {
      body = guideRequestSchema.parse({ content: await req.text() });
    } else if (contentType.toLowerCase().includes("multipart/form-data")) {
      const formData = await req.formData();
      const imageEntries = [...formData.getAll("images"), ...formData.getAll("image")];
      const images = await Promise.all(
        imageEntries.map(async (entry) => {
          if (typeof entry === "string") {
            return entry.trim();
          }
          return fileToDataUrl(entry);
        }),
      );

      body = guideRequestSchema.parse({
        content: formData.get("content"),
        images: images.filter((image) => image.length > 0),
      });
    } else {
      body = guideRequestSchema.parse(await req.json());
    }

    const response = await runDirectGuidePlan(body);
    return jsonResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
