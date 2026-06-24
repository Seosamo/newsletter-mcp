import type {
  ApiCatalogEntry,
  ApiConnectorRecommendation,
  ApiConnectorSelectionInput
} from "./types.js";

export type ConnectorConfigState = Record<string, string[]>;

const NEWSLETTER_DOMAIN_KEYWORDS = [
  "event", "events", "festival", "exhibition", "culture", "tourism", "travel", "place",
  "media", "content", "news", "book", "books", "traffic", "transport", "weather",
  "environment", "finance", "economy", "concert", "museum", "library",
  "행사", "축제", "전시", "문화", "관광", "교통", "날씨", "환경", "금융", "경제", "도서"
];

const SUPPORTED_CONNECTORS = new Set([
  "tourapi",
  "culture_info",
  "eventbrite",
  "ticketmaster",
  "kma_weather",
  "openaq"
]);

export class ApiCatalogSelector {
  constructor(
    private readonly entries: ApiCatalogEntry[],
    private readonly connectorConfigState: ConnectorConfigState = {}
  ) {}

  select(input: ApiConnectorSelectionInput, limit = 8): ApiConnectorRecommendation[] {
    const terms = buildTerms(input);
    return this.entries
      .map((entry) => this.scoreEntry(entry, terms))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  private scoreEntry(entry: ApiCatalogEntry, terms: string[]): ApiConnectorRecommendation {
    const haystack = `${entry.category} ${entry.name} ${entry.description} ${entry.keywords.join(" ")}`.toLocaleLowerCase();
    const reasons: string[] = [];
    let score = 0;

    const matchedTerms = terms.filter((term) => haystack.includes(term));
    if (matchedTerms.length > 0) {
      score += matchedTerms.length * 12;
      reasons.push(`matches request terms: ${matchedTerms.slice(0, 5).join(", ")}`);
    }

    const domainMatches = NEWSLETTER_DOMAIN_KEYWORDS.filter((term) => haystack.includes(term.toLocaleLowerCase()));
    if (domainMatches.length > 0) {
      score += Math.min(domainMatches.length * 4, 20);
      reasons.push("fits newsletter content domains");
    }

    if (entry.auth.toLocaleLowerCase() === "no") {
      score += 8;
      reasons.push("does not require authentication");
    }

    if (entry.https === "Yes") {
      score += 5;
      reasons.push("supports HTTPS");
    }

    const supported = Boolean(entry.connectorId && SUPPORTED_CONNECTORS.has(entry.connectorId));
    const requiresConfig = entry.connectorId ? this.connectorConfigState[entry.connectorId] ?? [] : [];
    const callable = supported && requiresConfig.length === 0;

    if (supported) {
      score += 10;
      reasons.push("has an allowlisted connector implementation");
    }

    if (callable) {
      score += 10;
      reasons.push("required connector configuration is present");
    } else if (requiresConfig.length > 0) {
      reasons.push(`requires configuration: ${requiresConfig.join(", ")}`);
    }

    return {
      entry,
      score,
      reasons,
      supported,
      callable,
      requiresConfig
    };
  }
}

export function buildTerms(input: ApiConnectorSelectionInput): string[] {
  return [...new Set([
    ...input.interests,
    ...input.regions,
    ...(input.keywords ?? [])
  ]
    .join(" ")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2))];
}
