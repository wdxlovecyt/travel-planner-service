import { createServer } from "node:http";
import { runChat } from "./chat/runChat.js";
import { runGuideTextChat } from "./chat/guideChat.js";
import { runChatStream, writeStreamError } from "./chat/streamChat.js";
import {
  planSegmentRoutes,
  type RoutePlanningSegmentInput,
} from "./tools/amap/segmentRoutePlanning.js";

const PORT = 3000;

function readRawBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      resolve(data);
      });
    req.on("error", reject);
  });
}

function readJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    readRawBody(req)
      .then((data) => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      })
      .catch(reject);
  });
}

type RoutePlanRequestBody = {
  segments?: RoutePlanningSegmentInput[];
  city?: string;
};

type GuideTextRequestBody = {
  message?: string;
  guide_text?: string;
  images?: string[];
  title?: string;
  url?: string;
  site_name?: string;
  published_at?: string;
  primary_location?: string;
};

async function fileToDataUrl(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function startSseHeartbeat(
  res: import("node:http").ServerResponse,
  getStage: () => string,
) {
  const startedAt = Date.now();
  return setInterval(() => {
    res.write("event: ping\n");
    res.write(
      `data: ${JSON.stringify({
        stage: getStage(),
        elapsed_seconds: Math.floor((Date.now() - startedAt) / 1000),
        message: "正在处理中",
      })}\n\n`,
    );
  }, 10_000);
}

async function readGuideTextBody(
  req: import("node:http").IncomingMessage,
): Promise<GuideTextRequestBody> {
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.toLowerCase().startsWith("text/plain")) {
    return { guide_text: await readRawBody(req) };
  }

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const request = new Request(
      "http://localhost/guide-text",
      {
        method: req.method ?? "POST",
        headers: req.headers as Record<string, string>,
        body: req as never,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    const formData = await request.formData();
    const body: GuideTextRequestBody = {};

    const assignString = (
      name:
        | "guide_text"
        | "message"
        | "title"
        | "url"
        | "site_name"
        | "published_at"
        | "primary_location",
    ) => {
      const value = formData.get(name);
      if (typeof value === "string" && value.trim()) {
        body[name] = value;
      }
    };

    assignString("guide_text");
    assignString("message");
    assignString("title");
    assignString("url");
    assignString("site_name");
    assignString("published_at");
    assignString("primary_location");

    const imageEntries = [...formData.getAll("images"), ...formData.getAll("image")];
    const images = await Promise.all(
      imageEntries.map(async (entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        return fileToDataUrl(entry);
      }),
    );

    if (images.some((image) => image.length > 0)) {
      body.images = images.filter((image) => image.length > 0);
    }

    return body;
  }

  return (await readJsonBody(req)) as GuideTextRequestBody;
}

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "GET" && req.url === "/health") {
    res.statusCode = 200;
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "POST" && req.url === "/chat") {
    try {
      const body = await readJsonBody(req);
      const prompt =
        (typeof body.message === "string" ? body.message.trim() : "") ||
        "What's the weather like in Shanghai, China?";
      const answer = await runChat(prompt);

      res.statusCode = 200;
      if (typeof answer === "string") {
        res.end(JSON.stringify({ reply: answer }));
      } else {
        res.end(JSON.stringify(answer));
      }
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    return;
  }

  if (req.method === "POST" && req.url === "/chat/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive?.(true);

    try {
      const body = await readJsonBody(req);
      const prompt =
        (typeof body.message === "string" ? body.message.trim() : "") ||
        "What's the weather like in Shanghai, China?";
      await runChatStream(prompt, res);
    } catch (error) {
      writeStreamError(res, error);
    } finally {
      res.end();
    }
    return;
  }

  if (req.method === "POST" && req.url === "/route-plan") {
    try {
      const body = (await readJsonBody(req)) as RoutePlanRequestBody;
      const response = await planSegmentRoutes({
        segments: Array.isArray(body.segments) ? body.segments : [],
        ...(typeof body.city === "string" ? { city: body.city } : {}),
      });

      res.statusCode = 200;
      res.end(JSON.stringify(response));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    return;
  }

  if (req.method === "POST" && req.url === "/guide-text") {
    try {
      const body = await readGuideTextBody(req);
      const response = await runGuideTextChat({
        guide_text: typeof body.guide_text === "string" ? body.guide_text : "",
        ...(Array.isArray(body.images)
          ? { images: body.images.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(typeof body.message === "string" ? { message: body.message } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.site_name === "string" ? { site_name: body.site_name } : {}),
        ...(typeof body.published_at === "string"
          ? { published_at: body.published_at }
          : {}),
        ...(typeof body.primary_location === "string"
          ? { primary_location: body.primary_location }
          : {}),
      });

      res.statusCode = 200;
      res.end(JSON.stringify(response));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    return;
  }

  if (req.method === "POST" && req.url === "/guide-text/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive?.(true);

    const writeSse = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    let currentStage = "thinking";
    const heartbeat = startSseHeartbeat(res, () => currentStage);

    try {
      const body = await readGuideTextBody(req);

      writeSse("start", { message: "stream connected" });
      const response = await runGuideTextChat({
        guide_text: typeof body.guide_text === "string" ? body.guide_text : "",
        ...(Array.isArray(body.images)
          ? { images: body.images.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(typeof body.message === "string" ? { message: body.message } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.site_name === "string" ? { site_name: body.site_name } : {}),
        ...(typeof body.published_at === "string"
          ? { published_at: body.published_at }
          : {}),
        ...(typeof body.primary_location === "string"
          ? { primary_location: body.primary_location }
          : {}),
      }, {
        onStatus: async (stage, message) => {
          currentStage = stage;
          writeSse("status", { stage, message });
        },
        onResult: async (result) => {
          currentStage = "result";
          writeSse("result", result);
        },
      });

      writeSse("result", response);
      writeSse("done", { ok: true });
    } catch (error) {
      writeSse("error", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      writeSse("done", { ok: false });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
});

server.on("error", (err) => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use, stopping.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});
