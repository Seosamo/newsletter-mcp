import type {
  FinalNewsletter,
  GenerateFinalNewsletterInput,
  NewsletterDraft,
  NewsletterOutputFormat
} from "../domain/types.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { NewsletterDraftGenerator } from "./draftGenerator.js";

export class FinalNewsletterRenderer {
  constructor(
    private readonly draftGenerator: NewsletterDraftGenerator,
    private readonly llmProvider: LlmProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  async generate(input: GenerateFinalNewsletterInput): Promise<FinalNewsletter> {
    const draft = await this.draftGenerator.generate(input);
    const outputFormat = input.outputFormat ?? "markdown";
    const result = await this.llmProvider.generate({
      model: input.model,
      instructions: buildInstructions(outputFormat),
      messages: [
        {
          role: "user",
          content: buildUserPrompt(draft, outputFormat)
        }
      ]
    });

    return {
      draft,
      newsletter: {
        content: result.content,
        format: outputFormat,
        model: result.model,
        generatedAt: this.now().toISOString()
      },
      warnings: draft.warnings
    };
  }
}

function buildInstructions(outputFormat: NewsletterOutputFormat): string {
  return [
    "You are a newsletter editor.",
    "Write the final newsletter in Korean unless the user message explicitly requests another language.",
    "Use only the provided draft JSON as factual grounding.",
    "Do not invent facts, dates, URLs, events, places, or recommendations.",
    "Preserve uncertainty by saying when the draft has limited evidence.",
    "Include source names and links when available.",
    `Return only the final newsletter body in ${outputFormat} format.`
  ].join("\n");
}

function buildUserPrompt(draft: NewsletterDraft, outputFormat: NewsletterOutputFormat): string {
  return [
    `Output format: ${outputFormat}`,
    "Create a polished newsletter from this structured draft.",
    "Keep the sections aligned with the draft section order:",
    "1. 오늘 주요 소식",
    "2. 주요 일정",
    "3. 상세 해설",
    "4. 관련 행사/장소/도서 추천",
    "",
    "Structured draft JSON:",
    JSON.stringify(draft, null, 2)
  ].join("\n");
}
