export type LlmMessage = {
  role: "developer" | "user";
  content: string;
};

export type LlmGenerateInput = {
  model?: string;
  instructions: string;
  messages: LlmMessage[];
};

export type LlmGenerateResult = {
  content: string;
  model: string;
};

export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}
