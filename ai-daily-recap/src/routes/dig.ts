import crypto from "crypto";
import { AiMessage, AiModels, askAiStream, HttpResponseError } from "../ai";
import { getCachedDig, setCachedDig } from "../digCache";

/** Type for Bun route handlers. */
export type RouteHandler = (req: Request) => Promise<Response> | Response;

/**
 * Build routes dedicated to the /dig feature (UI + streaming proxy).
 * - GET /dig                -> serve static HTML with security headers
 * - GET /public/dig.css     -> serve CSS with proper content type and nosniff
 * - GET /public/dig.js      -> serve JS with proper content type and nosniff
 * - POST/OPTIONS /dig/stream-> SSE proxy with caching, retry-once, and CORS
 */
export function digRoutes(): Record<string, RouteHandler> {
  /** CORS headers for the streaming endpoint. Kept internal to this module. */
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  } as const;

  /** Security headers for the static HTML response. */
  const staticHtmlHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } as const;

  /** Security headers for static assets (CSS/JS). */
  const staticAssetHeaders = (contentType: string) => ({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });

  return {
    /** Serve the /dig static page */
    "/dig": async (_req) => {
      try {
        const html = await Bun.file("public/dig.html").text();
        return new Response(html, { headers: { ...staticHtmlHeaders } });
      } catch (_e) {
        return new Response("Not Found", { status: 404 });
      }
    },

    /** Serve CSS */
    "/public/dig.css": async (_req) => {
      try {
        const css = await Bun.file("public/dig.css").text();
        return new Response(css, {
          headers: staticAssetHeaders("text/css; charset=utf-8"),
        });
      } catch (_e) {
        return new Response("Not Found", { status: 404 });
      }
    },

    /** Serve JS */
    "/public/dig.js": async (_req) => {
      try {
        const js = await Bun.file("public/dig.js").text();
        return new Response(js, {
          headers: staticAssetHeaders("application/javascript; charset=utf-8"),
        });
      } catch (_e) {
        return new Response("Not Found", { status: 404 });
      }
    },

    /** Streaming proxy with caching and retry-once semantics */
    "/dig/stream": async (req) => {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...corsHeaders } });
      }
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { ...corsHeaders },
        });
      }

      const started = Date.now();
      try {
        if (
          req.headers.get("content-type")?.includes("application/json") !== true
        ) {
          return new Response(
            JSON.stringify({ error: { message: "Invalid Content-Type" } }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        const body = (await req.json()) as {
          article_url?: string;
          messages?: AiMessage[];

        };
        const articleUrl = body.article_url || "";

        const messages = Array.isArray(body.messages) ? body.messages : [];

        let urlOk = false;
        try {
          const u = new URL(articleUrl);
          urlOk = u.protocol === "http:" || u.protocol === "https:";
        } catch {
          urlOk = false;
        }
        if (!articleUrl || !urlOk) {
          return new Response(
            JSON.stringify({ error: { message: "Invalid article_url" } }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        const initialDig =
          messages.length === 2 &&
          messages[0]?.role === "system" &&
          messages[1]?.role === "user";
        const articleHash = crypto
          .createHash("sha256")
          .update(articleUrl)
          .digest("hex")
          .slice(0, 12);

        // Cached fast-path for initial dig
        const cached = initialDig ? getCachedDig(articleUrl) : null;
        if (cached) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const chunk = {
                id: "cached",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: AiModels.PERPLEXITY,
                choices: [
                  {
                    index: 0,
                    delta: { content: cached.markdown },
                    finish_reason: "stop",
                  },
                ],
              } as const;
              controller.enqueue(
                encoder.encode("data: " + JSON.stringify(chunk) + "\n"),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n"));
              controller.close();
            },
          });
          const headers = {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            ...corsHeaders,
          };
          const latency = Date.now() - started;
          console.log(
            `${new Date().toISOString()} model=${AiModels.PERPLEXITY} article=${articleHash} latency_ms=${latency} usage=cached`,
          );
          return new Response(stream, { headers });
        }

        // Pre-stream: attempt to obtain first chunk to detect 5xx
        async function getGeneratorFirstChunk() {
          const gen = askAiStream(messages, { model: AiModels.PERPLEXITY });
          try {
            const first = await gen.next();
            return { gen, first } as const;
          } catch (e) {
            throw e;
          }
        }

        let firstGen: AsyncGenerator<
          import("../ai").OpenRouterStreamChunk
        > | null = null;
        let firstChunk: IteratorResult<
          import("../ai").OpenRouterStreamChunk
        > | null = null;
        try {
          const { gen, first } = await getGeneratorFirstChunk();
          firstGen = gen;
          firstChunk = first;
        } catch (err) {
          if (
            err instanceof HttpResponseError &&
            err.status >= 500 &&
            err.status < 600
          ) {
            // retry once
            try {
              const { gen, first } = await getGeneratorFirstChunk();
              firstGen = gen;
              firstChunk = first;
            } catch (err2) {
              const headers = {
                "Content-Type": "application/json",
                ...corsHeaders,
              };
              return new Response(
                JSON.stringify({
                  error: { message: "Upstream error", detail: String(err2) },
                }),
                { status: 502, headers },
              );
            }
          } else {
            const headers = {
              "Content-Type": "application/json",
              ...corsHeaders,
            };
            return new Response(
              JSON.stringify({
                error: { message: "Upstream error", detail: String(err) },
              }),
              { status: 502, headers },
            );
          }
        }

        const encoder = new TextEncoder();
        let assistantAccum = "";
        let usage:
          | {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            }
          | undefined;

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Send first chunk if present
            if (firstChunk && !firstChunk.done && firstChunk.value) {
              const v = firstChunk.value;
              const delta = v?.choices?.[0]?.delta?.content as
                | string
                | undefined;
              if (delta) assistantAccum += delta;
              if (v?.usage) usage = v.usage;
              controller.enqueue(
                encoder.encode("data: " + JSON.stringify(v) + "\n"),
              );
            }
            // Continue streaming remaining chunks
            const gen = firstGen as AsyncGenerator<
              import("../ai").OpenRouterStreamChunk
            >;
            try {
              for await (const chunk of gen) {
                const delta = chunk?.choices?.[0]?.delta?.content as
                  | string
                  | undefined;
                if (delta) assistantAccum += delta;
                if (chunk?.usage) usage = chunk.usage;
                controller.enqueue(
                  encoder.encode("data: " + JSON.stringify(chunk) + "\n"),
                );
                if (chunk?.error) break;
              }
            } catch (_e) {
              // swallow, client sees what was streamed so far
            } finally {
              controller.enqueue(encoder.encode("data: [DONE]\n"));
              controller.close();
              // Cache if initial dig and we have content
              if (initialDig && assistantAccum) {
                setCachedDig(articleUrl, assistantAccum);
              }
              const latency = Date.now() - started;
              const usageStr = usage
                ? `pt=${usage.prompt_tokens} ct=${usage.completion_tokens} tt=${usage.total_tokens}`
                : "";
              console.log(
                `${new Date().toISOString()} model=${AiModels.PERPLEXITY} article=${articleHash} latency_ms=${latency} ${usageStr}`,
              );
            }
          },
        });

        const headers = {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          ...corsHeaders,
        };
        return new Response(stream, { headers });
      } catch (error) {
        const headers = { "Content-Type": "application/json", ...corsHeaders };
        return new Response(
          JSON.stringify({
            error: { message: "Internal error", detail: String(error) },
          }),
          { status: 500, headers },
        );
      }
    },
  };
}
