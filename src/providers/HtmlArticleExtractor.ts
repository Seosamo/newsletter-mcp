import { createHash } from "node:crypto";

type FetchResponseLike = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: {
    get(name: string): string | null;
  };
  json?(): Promise<unknown>;
  text(): Promise<string>;
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

export type ExtractedArticle = {
  id: string;
  url: string;
  title?: string;
  description?: string;
  text: string;
  publishedAt?: string;
  sourceName: string;
};

type HtmlArticleExtractorOptions = {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxTextChars?: number;
  userAgent?: string;
};

export class HtmlArticleExtractor {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxTextChars: number;
  private readonly userAgent: string;

  constructor(options: HtmlArticleExtractorOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxTextChars = options.maxTextChars ?? 5000;
    this.userAgent = options.userAgent ?? "chat-newsletter-mcp/0.1";
  }

  async extract(url: string): Promise<ExtractedArticle> {
    const response = await this.fetchFn(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": this.userAgent
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`HTML fetch failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    }

    const contentType = response.headers?.get("content-type") ?? "";
    if (contentType && !contentType.toLocaleLowerCase().includes("html")) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    return extractArticleFromHtml(url, await response.text(), this.maxTextChars);
  }
}

export function extractArticleFromHtml(url: string, html: string, maxTextChars = 5000): ExtractedArticle {
  const cleanHtml = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");

  const title = firstNonEmpty([
    getMetaContent(cleanHtml, "property", "og:title"),
    getMetaContent(cleanHtml, "name", "twitter:title"),
    getTagText(cleanHtml, "title")
  ]);
  const description = firstNonEmpty([
    getMetaContent(cleanHtml, "property", "og:description"),
    getMetaContent(cleanHtml, "name", "description"),
    getMetaContent(cleanHtml, "name", "twitter:description")
  ]);
  const publishedAt = toDateOnly(firstNonEmpty([
    getMetaContent(cleanHtml, "property", "article:published_time"),
    getMetaContent(cleanHtml, "name", "pubdate"),
    getMetaContent(cleanHtml, "itemprop", "datePublished"),
    getTimeDatetime(cleanHtml)
  ]));
  const text = htmlToText(cleanHtml).slice(0, maxTextChars).trim();

  return {
    id: createHash("sha1").update(url).digest("hex").slice(0, 16),
    url,
    title,
    description,
    text,
    publishedAt,
    sourceName: sourceNameFromUrl(url)
  };
}

function getMetaContent(html: string, attributeName: string, attributeValue: string): string | undefined {
  const escapedName = escapeRegExp(attributeName);
  const escapedValue = escapeRegExp(attributeValue);
  const metaPattern = new RegExp(`<meta\\b(?=[^>]*\\b${escapedName}\\s*=\\s*["']${escapedValue}["'])(?=[^>]*\\bcontent\\s*=\\s*["']([^"']+)["'])[^>]*>`, "i");
  return decodeHtml(metaPattern.exec(html)?.[1]);
}

function getTagText(html: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  return decodeHtml(stripTags(pattern.exec(html)?.[1] ?? ""));
}

function getTimeDatetime(html: string): string | undefined {
  const match = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>/i.exec(html);
  return decodeHtml(match?.[1]);
}

function htmlToText(html: string): string {
  return (decodeHtml(
    stripTags(
      html
        .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|blockquote)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
    )
  ) ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .trim();
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0);
}

function toDateOnly(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

function sourceNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
