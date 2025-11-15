import fs from "fs";

export enum AiModels {
  CLAUDE = "anthropic/claude-3.7-sonnet",
  CLAUDE_THINKING = "anthropic/claude-3.7-sonnet:thinking",
  GPT4_1 = "openai/gpt-4.1",
  GEMINI_FLASH = "google/gemini-2.0-flash-001",
  PERPLEXITY = "perplexity/sonar-reasoning-pro",

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
