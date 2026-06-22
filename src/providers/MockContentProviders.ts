import { createHash } from "node:crypto";
import type { ContentItem, ContentProviderResult, ContentSearchInput } from "../domain/types.js";
import type { ContentProvider } from "./ContentProvider.js";

export class MockNewsProvider implements ContentProvider {
  readonly name = "mock-news";

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    const items = input.interests.map((interest, index) => {
      const region = input.regions[index % Math.max(input.regions.length, 1)] ?? "";
      const title = region
        ? `${interest} 관련 ${region} 주요 동향`
        : `${interest} 관련 주요 동향`;
      return makeItem({
        type: "news",
        title,
        summary: `${interest} 관심사를 중심으로 요청 기간에 확인할 만한 주요 소식 후보입니다.`,
        interestTags: [interest],
        regions: region ? [region] : [],
        keywords: input.keywords,
        sourceName: "Mock News",
        publishedAt: input.period.end,
        evidence: [`관심 태그 '${interest}'와 요청 기간 ${input.period.start}~${input.period.end}를 기준으로 생성된 mock 뉴스 후보입니다.`],
        sourceReliability: 0.65
      });
    });
    return { items, warnings: [] };
  }
}

export class MockEventProvider implements ContentProvider {
  readonly name = "mock-events";

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    const items = input.interests.slice(0, 3).map((interest, index) => {
      const region = input.regions[index % Math.max(input.regions.length, 1)] ?? "";
      const title = region
        ? `${region} ${interest} 관련 일정 체크`
        : `${interest} 관련 일정 체크`;
      return makeItem({
        type: "event",
        title,
        summary: `${interest}와 연결되는 일정, 행사, 공개일 또는 마감일 후보입니다.`,
        interestTags: [interest],
        regions: region ? [region] : [],
        keywords: input.keywords,
        sourceName: "Mock Events",
        eventDate: input.period.end,
        evidence: [`관심 태그 '${interest}'에 맞춰 일정 섹션 검증용으로 생성된 mock 일정입니다.`],
        sourceReliability: 0.6
      });
    });
    return { items, warnings: [] };
  }
}

export class MockRecommendationProvider implements ContentProvider {
  readonly name = "mock-recommendations";

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    const items = input.interests.slice(0, 3).map((interest, index) => {
      const region = input.regions[index % Math.max(input.regions.length, 1)] ?? "";
      const title = region
        ? `${region}에서 이어서 볼 만한 ${interest} 추천`
        : `이어서 볼 만한 ${interest} 추천`;
      return makeItem({
        type: "recommendation",
        title,
        summary: `${interest} 관심사와 이어지는 장소, 도서, 전시, 콘텐츠 추천 후보입니다.`,
        interestTags: [interest],
        regions: region ? [region] : [],
        keywords: input.keywords,
        sourceName: "Mock Recommendations",
        publishedAt: input.period.end,
        evidence: [`사용자 취향 태그 '${interest}'를 추천 섹션에 연결하기 위한 mock 추천입니다.`],
        sourceReliability: 0.55
      });
    });
    return { items, warnings: [] };
  }
}

type MakeItemInput = Omit<ContentItem, "id">;

function makeItem(input: MakeItemInput): ContentItem {
  return {
    id: contentId(input.sourceName ?? "mock", input.title),
    ...input
  };
}

function contentId(sourceName: string, title: string): string {
  return createHash("sha1").update(`${sourceName}:${title}`).digest("hex").slice(0, 16);
}
