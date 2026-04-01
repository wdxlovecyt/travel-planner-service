import { ZodError } from "zod";
import { runDirectGuidePlan } from "../../../planner/guidePlan";
import { fileToDataUrl } from "../../../server/files";
import { sseResponse } from "../../../server/response";
import { guideRequestSchema } from "../../../server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return sseResponse(async (write) => {
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

      await write("start", { message: "stream connected" });
      const response = await runDirectGuidePlan(body, {
          onStatus: async (stage, message) => {
            await write("status", { stage, message });
          },
          onResult: async (result) => {
            await write("result", result);
          },
        });

      await write("result", response);
      await write("done", { ok: true });
    } catch (error) {
      const message =
        error instanceof ZodError
          ? error.issues.map((issue) => issue.message).join("; ")
          : error instanceof Error
            ? error.message
            : "Unknown error";
      await write("error", {
        error: message,
      });
      await write("done", { ok: false });
    }
  });
}
