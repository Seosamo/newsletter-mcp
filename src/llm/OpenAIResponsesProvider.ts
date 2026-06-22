import type { LlmGenerateInput, LlmGenerateResult, LlmProvider } from "./LlmProvider.js";

type OpenAIResponsesProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
};

type OpenAIResponseBody = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

export class OpenAIResponsesProvider implements LlmProvider {
  readonly name = "openai-responses";
  readonly defaultModel: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(options: OpenAIResponsesProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com");
    this.defaultModel = options.defaultModel ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required to generate the final newsletter.");
    }

    const model = input.model ?? this.defaultModel;
    const response = await fetch(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        instructions: input.instructions,
        input: input.messages
      })
    });

    const body = (await response.json()) as OpenAIResponseBody;
    if (!response.ok) {
      throw new Error(body.error?.message ?? `OpenAI Responses API failed with status ${response.status}`);
    }

    const content = extractText(body);
    if (!content) {
      throw new Error("OpenAI Responses API returned no text content.");
    }

    return {
      content,
      model
    };
  }
}

function extractText(body: OpenAIResponseBody): string {
  if (body.output_text?.trim()) {
    return body.output_text.trim();
  }

  return (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("")
    .trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
