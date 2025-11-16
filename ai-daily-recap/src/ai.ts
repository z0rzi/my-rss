import fs from "fs";

export enum AiModels {
  CLAUDE = "anthropic/claude-3.7-sonnet",
  CLAUDE_THINKING = "anthropic/claude-3.7-sonnet:thinking",
  GPT4_1 = "openai/gpt-4.1",
  GEMINI_FLASH = "google/gemini-2.0-flash-001",
  PERPLEXITY = "perplexity/sonar-pro-search",

  CHEAP = "google/gemini-2.0-flash-001",
}

export type AiOptions = {
  model?: AiModels;
};

export type AiMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type OpenRouterResponse = {
  id: string;
  provider: string;
  model: string;
  object: string;
  created: number;
  choices: {
    logprobs: null;
    finish_reason: string;
    native_finish_reason: string;
    index: number;
    message: {
      role: string;
      content: string;
      refusal: null;
    };
  }[] /* x1 */;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

/** Streaming chunk shape for OpenRouter SSE responses. */
export type OpenRouterStreamChunk = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  provider?: string;
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { code?: string | number; message: string };
};

/** Error thrown when OpenRouter returns a non-OK status before streaming starts. */
export class HttpResponseError extends Error {
  status: number;
  statusText: string;
  bodyText: string;
  constructor(status: number, statusText: string, bodyText: string) {
    super(`HTTP ${status} ${statusText}: ${bodyText}`);
    this.status = status;
    this.statusText = statusText;
    this.bodyText = bodyText;
  }
}

export async function askAi(messages: AiMessage[], options?: AiOptions) {
  const fetchParams = {
    model: options?.model ?? AiModels.CHEAP,
    messages: messages,
  };

  const res = (await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fetchParams),
  }).then((res) => res.json())) as OpenRouterResponse;

  if (!res.choices[0].message.content) {
    fs.writeFileSync("/tmp/ai-response.json", JSON.stringify(res, null, 2));
    console.error("No content in response...");
    console.log("Logging to /tmp/ai-response.json");
    process.exit(1);
  }

  return res.choices[0].message.content;
}

/**
 * Stream responses from OpenRouter chat completions API.
 * Yields parsed SSE "data: {json}" objects as they arrive.
 */
export async function* askAiStream(
  messages: AiMessage[],
  options?: AiOptions & { model?: AiModels },
): AsyncGenerator<OpenRouterStreamChunk> {
  const fetchParams = {
    model: options?.model ?? AiModels.PERPLEXITY,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  } as const;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fetchParams),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw new HttpResponseError(res.status, res.statusText, bodyText);
  }

  const body = res.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);

        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data) as OpenRouterStreamChunk;
          yield parsed;
        } catch {
          // Ignore non-JSON payloads
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
