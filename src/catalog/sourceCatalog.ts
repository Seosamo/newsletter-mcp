import type { SourcePreference } from "../domain/types.js";

export type SourceCatalogEntry = SourcePreference & {
  id: string;
  description: string;
  categories: string[];
  keywords: string[];
  regions: string[];
};

export type SourceRecommendation = {
  source: SourcePreference;
  description: string;
  score: number;
  reasons: string[];
};

type SourceRecommendationInput = {
  interests?: string[];
  regions?: string[];
  keywords?: string[];
};

const DEFAULT_SOURCE_CATALOG: SourceCatalogEntry[] = [
  {
    id: "openai-blog",
    label: "OpenAI Blog",
    description: "Official OpenAI product, research, and company updates.",
    categories: ["ai", "technology", "developer", "machine learning"],
    keywords: ["openai", "chatgpt", "gpt", "llm", "api", "developer tools", "research"],
    regions: ["global", "us"],
    domains: ["openai.com"],
    rssUrls: ["https://openai.com/blog/rss.xml"],
    queryHints: ["site:openai.com"],
    weight: 1.5,
    enabled: true
  },
  {
    id: "techcrunch",
    label: "TechCrunch",
    description: "Technology startup, venture, and product news.",
    categories: ["technology", "startup", "ai", "business"],
    keywords: ["tech", "startup", "venture", "ai", "apps", "platform"],
    regions: ["global", "us"],
    domains: ["techcrunch.com"],
    rssUrls: ["https://techcrunch.com/feed/"],
    queryHints: ["site:techcrunch.com"],
    weight: 1.3,
    enabled: true
  },
  {
    id: "arxiv",
    label: "arXiv",
    description: "Research preprints across AI, computer science, physics, and mathematics.",
    categories: ["ai", "research", "technology", "science"],
    keywords: ["paper", "research", "preprint", "machine learning", "llm", "computer science"],
    regions: ["global"],
    domains: ["arxiv.org"],
    rssUrls: [],
    queryHints: ["site:arxiv.org"],
    weight: 1.2,
    enabled: true
  },
  {
    id: "hacker-news",
    label: "Hacker News",
    description: "Developer and startup community discussions.",
    categories: ["developer", "technology", "startup"],
    keywords: ["developer", "programming", "startup", "engineering", "software"],
    regions: ["global"],
    domains: ["news.ycombinator.com"],
    rssUrls: ["https://news.ycombinator.com/rss"],
    queryHints: ["site:news.ycombinator.com"],
    weight: 1.15,
    enabled: true
  },
  {
    id: "github-blog",
    label: "GitHub Blog",
    description: "GitHub platform, developer workflow, and open source updates.",
    categories: ["developer", "technology", "open source"],
    keywords: ["github", "developer tools", "open source", "code", "software"],
    regions: ["global"],
    domains: ["github.blog"],
    rssUrls: ["https://github.blog/feed/"],
    queryHints: ["site:github.blog"],
    weight: 1.25,
    enabled: true
  },
  {
    id: "vercel-blog",
    label: "Vercel Blog",
    description: "Frontend, web platform, deployment, and framework updates.",
    categories: ["developer", "technology", "frontend", "web"],
    keywords: ["vercel", "next.js", "frontend", "web", "deployment", "developer tools"],
    regions: ["global"],
    domains: ["vercel.com"],
    rssUrls: ["https://vercel.com/atom"],
    queryHints: ["site:vercel.com/blog"],
    weight: 1.2,
    enabled: true
  },
  {
    id: "cloudflare-blog",
    label: "Cloudflare Blog",
    description: "Internet infrastructure, security, and developer platform updates.",
    categories: ["developer", "technology", "security", "infrastructure"],
    keywords: ["cloudflare", "security", "network", "infrastructure", "workers", "developer tools"],
    regions: ["global"],
    domains: ["blog.cloudflare.com"],
    rssUrls: ["https://blog.cloudflare.com/rss/"],
    queryHints: ["site:blog.cloudflare.com"],
    weight: 1.2,
    enabled: true
  },
  {
    id: "reuters-business",
    label: "Reuters Business",
    description: "Global business, markets, and economy coverage.",
    categories: ["economy", "business", "finance", "markets"],
    keywords: ["economy", "business", "finance", "market", "stocks", "policy"],
    regions: ["global", "us", "europe", "asia"],
    domains: ["reuters.com"],
    rssUrls: [],
    queryHints: ["site:reuters.com/business"],
    weight: 1.3,
    enabled: true
  },
  {
    id: "bloomberg",
    label: "Bloomberg",
    description: "Business, finance, markets, and economic analysis.",
    categories: ["economy", "business", "finance", "markets"],
    keywords: ["economy", "finance", "market", "stocks", "business", "central bank"],
    regions: ["global", "us", "asia"],
    domains: ["bloomberg.com"],
    rssUrls: [],
    queryHints: ["site:bloomberg.com"],
    weight: 1.25,
    enabled: true
  },
  {
    id: "korea-culture-portal",
    label: "Culture Portal",
    description: "Korean culture, exhibitions, performances, and public culture information.",
    categories: ["culture", "exhibition", "performance", "museum", "book"],
    keywords: ["culture", "exhibition", "performance", "museum", "library", "book"],
    regions: ["korea", "seoul"],
    domains: ["culture.go.kr"],
    rssUrls: [],
    queryHints: ["site:culture.go.kr"],
    weight: 1.25,
    enabled: true
  }
];

export function recommendSourcePreferences(
  input: SourceRecommendationInput,
  limit = 8
): SourceRecommendation[] {
  const terms = normalizeTerms([
    ...(input.interests ?? []),
    ...(input.regions ?? []),
    ...(input.keywords ?? [])
  ]);
  if (terms.length === 0) {
    return [];
  }

  return DEFAULT_SOURCE_CATALOG
    .map((entry) => scoreEntry(entry, terms))
    .filter((recommendation) => recommendation.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function scoreEntry(entry: SourceCatalogEntry, terms: string[]): SourceRecommendation {
  const searchable = normalizeTerms([
    entry.label,
    entry.description,
    ...entry.categories,
    ...entry.keywords,
    ...entry.regions,
    ...entry.domains
  ]);
  const matchedCategories = entry.categories.filter((value) => terms.includes(value.toLocaleLowerCase()));
  const matchedKeywords = entry.keywords.filter((value) => terms.includes(value.toLocaleLowerCase()));
  const matchedRegions = entry.regions.filter((value) => terms.includes(value.toLocaleLowerCase()));
  const fuzzyMatches = terms.filter((term) => searchable.some((value) => value.includes(term) || term.includes(value)));

  const score =
    matchedCategories.length * 4 +
    matchedKeywords.length * 3 +
    matchedRegions.length * 2 +
    fuzzyMatches.length;

  const reasons = [
    matchedCategories.length > 0 ? `matched categories: ${matchedCategories.join(", ")}` : "",
    matchedKeywords.length > 0 ? `matched keywords: ${matchedKeywords.join(", ")}` : "",
    matchedRegions.length > 0 ? `matched regions: ${matchedRegions.join(", ")}` : "",
    fuzzyMatches.length > 0 ? `related terms: ${fuzzyMatches.slice(0, 4).join(", ")}` : ""
  ].filter(Boolean);

  return {
    source: {
      label: entry.label,
      domains: entry.domains,
      rssUrls: entry.rssUrls,
      queryHints: entry.queryHints,
      weight: entry.weight,
      enabled: entry.enabled
    },
    description: entry.description,
    score,
    reasons
  };
}

function normalizeTerms(values: string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean))];
}
