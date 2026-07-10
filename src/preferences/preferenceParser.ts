export type ParsedPreferenceMessage = {
  interests: string[];
  regions: string[];
};

type Alias = {
  canonical: string;
  aliases: string[];
};

const TOPICS: Alias[] = [
  { canonical: "주식", aliases: ["주식", "stock", "stocks", "equity", "equities"] },
  { canonical: "경제", aliases: ["경제", "economy", "economic"] },
  { canonical: "금융", aliases: ["금융", "finance", "financial"] },
  { canonical: "AI", aliases: ["인공지능", "ai", "artificial intelligence"] },
  { canonical: "기술", aliases: ["기술", "테크", "technology", "tech"] },
  { canonical: "부동산", aliases: ["부동산", "real estate"] },
  { canonical: "암호화폐", aliases: ["암호화폐", "가상자산", "코인", "crypto", "cryptocurrency"] },
  { canonical: "애니메이션", aliases: ["애니메이션", "애니", "animation", "anime"] },
  { canonical: "도서", aliases: ["도서", "책", "book", "books", "publishing"] },
  { canonical: "여행", aliases: ["여행", "travel"] },
  { canonical: "스포츠", aliases: ["스포츠", "sports"] },
  { canonical: "과학", aliases: ["과학", "science"] },
  { canonical: "문화", aliases: ["문화", "culture"] }
];

const REGIONS: Alias[] = [
  { canonical: "미국", aliases: ["미국", "미주", "usa", "u.s.", "us", "united states", "american"] },
  { canonical: "한국", aliases: ["한국", "대한민국", "korea", "korean"] },
  { canonical: "일본", aliases: ["일본", "japan", "japanese"] },
  { canonical: "중국", aliases: ["중국", "china", "chinese"] },
  { canonical: "유럽", aliases: ["유럽", "europe", "european", "eu"] },
  { canonical: "글로벌", aliases: ["글로벌", "전세계", "세계", "global", "worldwide"] }
];

const PREFERENCE_INTENT = /(?:받고\s*싶|구독|관심(?:이|은|을|가)?|선호|원해|원하|보고\s*싶|알려\s*줘|\bwant\b|\bsubscribe\b|\binterested\b|\bprefer\b|\bsend\s+me\b)/i;

/**
 * Extracts a conservative fallback preference patch from the original chat text.
 * The MCP client should still send structured fields; this parser prevents an
 * otherwise valid sourceMessage-only call from silently saving an empty profile.
 */
export function parsePreferenceMessage(message: string | undefined): ParsedPreferenceMessage {
  const text = message?.replace(/\s+/g, " ").trim() ?? "";
  if (!text || !PREFERENCE_INTENT.test(text)) {
    return { interests: [], regions: [] };
  }

  const regionMatches = findAliases(text, REGIONS);
  const topicMatches = findAliases(text, TOPICS);
  const interests: string[] = [];
  const regions = unique(regionMatches.map((match) => match.canonical));

  for (const topic of topicMatches) {
    interests.push(topic.canonical);
    const qualifier = closestPrecedingRegion(topic.index, regionMatches);
    if (qualifier) {
      interests.push(`${qualifier.canonical} ${topic.canonical}`);
    }
  }

  if (interests.length === 0) {
    interests.push(...extractNewsletterSubjects(text, regions));
  }

  return {
    interests: unique(interests),
    regions
  };
}

type AliasMatch = {
  canonical: string;
  index: number;
};

function findAliases(text: string, entries: Alias[]): AliasMatch[] {
  const normalized = text.toLocaleLowerCase();
  const matches: AliasMatch[] = [];

  for (const entry of entries) {
    const indexes = entry.aliases
      .map((alias) => ({ alias, index: findAliasIndex(normalized, alias.toLocaleLowerCase()) }))
      .filter((match) => match.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (indexes[0]) {
      matches.push({ canonical: entry.canonical, index: indexes[0].index });
    }
  }

  return matches.sort((left, right) => left.index - right.index);
}

function findAliasIndex(text: string, alias: string): number {
  if (/^[a-z0-9. ]+$/i.test(alias)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.search(new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i"));
  }
  return text.indexOf(alias);
}

function closestPrecedingRegion(topicIndex: number, regions: AliasMatch[]): AliasMatch | undefined {
  return [...regions]
    .reverse()
    .find((region) => region.index <= topicIndex && topicIndex - region.index <= 20);
}

function extractNewsletterSubjects(text: string, regions: string[]): string[] {
  const match = text.match(/(.+?)\s*뉴스레터/i);
  if (!match?.[1]) {
    return [];
  }

  const prefix = match[1]
    .replace(/^(?:난|나는|전|저는|제가|내가|우리|please)\s*/i, "")
    .replace(/^(?:매일|매주|매월|이번\s*주|오늘)\s*/i, "")
    .replace(/(?:에\s*대한|관련|소식|뉴스)\s*$/i, "")
    .trim();
  if (!prefix || prefix.length > 60) {
    return [];
  }

  return unique(prefix
    .split(/\s*(?:\/|,|·|&|\band\b|\s및\s)\s*/i)
    .map((value) => value.trim().replace(/(?:을|를|이|가|은|는)$/u, ""))
    .filter((value) => value.length >= 2 && !regions.includes(value)));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
