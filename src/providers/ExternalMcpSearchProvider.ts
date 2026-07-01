import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ContentItem, ContentProviderResult, ContentSearchInput } from "../domain/types.js";
import type { ContentProvider } from "./ContentProvider.js";
import {
  appendSelectedEvidenceChunks,
  chunkPageText,
  selectRelevantPageChunks
} from "./evidenceChunks.js";

export type ExternalMcpToolCall = {
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  toolName: string;
  toolArgs: Record<string, unknown>;
  timeoutMs: number;
};

export type ExternalMcpToolCaller = (call: ExternalMcpToolCall) => Promise<unknown>;

type ExternalMcpSearchProviderOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  toolName?: string;
  queryParameter?: string;
  maxResultsParameter?: string;
  regionParameter?: string;
  maxResults?: number;
  visitPageToolName?: string;
  visitPageUrlParameter?: string;
  maxPagesToVisit?: number;
  pageContentMaxChars?: number;
  pageChunkMaxChars?: number;
  pageChunkOverlapChars?: number;
  maxSelectedChunksPerPage?: number;
  maxSelectedChunksTotal?: number;
  timeoutMs?: number;
  toolCaller?: ExternalMcpToolCaller;
};

export class ExternalMcpSearchProvider implements ContentProvider {
  readonly name = "external-mcp-search";
  private readonly command?: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly toolName: string;
  private readonly queryParameter: string;
  private readonly maxResultsParameter?: string;
  private readonly regionParameter?: string;
  private readonly maxResults: number;
  private readonly visitPageToolName?: string;
  private readonly visitPageUrlParameter: string;
  private readonly maxPagesToVisit: number;
  private readonly pageChunkMaxChars: number;
  private readonly pageChunkOverlapChars: number;
  private readonly maxSelectedChunksPerPage: number;
  private readonly maxSelectedChunksTotal: number;
  private readonly timeoutMs: number;
  private readonly toolCaller: ExternalMcpToolCaller;

  constructor(options: ExternalMcpSearchProviderOptions = {}) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.toolName = options.toolName ?? "search";
    this.queryParameter = options.queryParameter ?? "query";
    this.maxResultsParameter = options.maxResultsParameter ?? "maxResults";
    this.regionParameter = options.regionParameter;
    this.maxResults = options.maxResults ?? 6;
    this.visitPageToolName = options.visitPageToolName;
    this.visitPageUrlParameter = options.visitPageUrlParameter ?? "url";
    this.maxPagesToVisit = options.maxPagesToVisit ?? 0;
    this.pageChunkMaxChars = options.pageChunkMaxChars ?? options.pageContentMaxChars ?? 1800;
    this.pageChunkOverlapChars = options.pageChunkOverlapChars ?? 200;
    this.maxSelectedChunksPerPage = options.maxSelectedChunksPerPage ?? 2;
    this.maxSelectedChunksTotal = options.maxSelectedChunksTotal ?? 8;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.toolCaller = options.toolCaller ?? callExternalMcpTool;
  }

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    if (!this.command) {
      return {
        items: [],
        warnings: ["External MCP search provider is disabled because EXTERNAL_MCP_SEARCH_COMMAND or NOAPI_GOOGLE_SEARCH_COMMAND is not configured."]
      };
    }

    const query = buildQuery(input);
    if (!query) {
      return {
        items: [],
        warnings: ["External MCP search provider skipped because no query terms were available."]
      };
    }

    const toolArgs: Record<string, unknown> = {
      [this.queryParameter]: query
    };
    if (this.maxResultsParameter) {
      toolArgs[this.maxResultsParameter] = this.maxResults;
    }
    if (this.regionParameter && input.regions[0]) {
      toolArgs[this.regionParameter] = input.regions[0];
    }

    try {
      const result = await this.toolCaller({
        command: this.command,
        args: this.args,
        cwd: this.cwd,
        env: buildChildEnv(this.env),
        toolName: this.toolName,
        toolArgs,
        timeoutMs: this.timeoutMs
      });
      const normalized = normalizeMcpSearchResult(result, input, this.maxResults);
      const failureMessage = normalized.length === 0 ? extractFailureMessage(result) : undefined;
      const warnings = failureMessage ? [failureMessage] : [];
      return {
        items: await this.enrichWithVisitedPages(normalized, warnings, input),
        warnings
      };
    } catch (error) {
      return {
        items: [],
        warnings: [`External MCP search failed: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  private async enrichWithVisitedPages(
    items: ContentItem[],
    warnings: string[],
    input: ContentSearchInput
  ): Promise<ContentItem[]> {
    if (!this.visitPageToolName || this.maxPagesToVisit <= 0) {
      return items;
    }

    const enriched: ContentItem[] = [];
    const childEnv = buildChildEnv(this.env);
    let selectedChunksTotal = 0;
    for (const [index, item] of items.entries()) {
      if (index >= this.maxPagesToVisit || !item.url) {
        enriched.push(item);
        continue;
      }
      if (selectedChunksTotal >= this.maxSelectedChunksTotal) {
        enriched.push(item);
        continue;
      }

      try {
        const pageResult = await this.toolCaller({
          command: this.command,
          args: this.args,
          cwd: this.cwd,
          env: childEnv,
          toolName: this.visitPageToolName,
          toolArgs: {
            [this.visitPageUrlParameter]: item.url
          },
          timeoutMs: this.timeoutMs
        });
        const pageText = extractVisitedPageText(pageResult);
        if (!pageText) {
          warnings.push(`External MCP page visit returned no readable text for ${item.url}.`);
          enriched.push(item);
          continue;
        }

        const chunks = chunkPageText(pageText, {
          maxChars: this.pageChunkMaxChars,
          overlapChars: this.pageChunkOverlapChars
        });
        const remainingChunkBudget = this.maxSelectedChunksTotal - selectedChunksTotal;
        const selectedChunks = selectRelevantPageChunks(
          chunks,
          input,
          Math.min(this.maxSelectedChunksPerPage, remainingChunkBudget)
        );
        selectedChunksTotal += selectedChunks.length;
        if (selectedChunks.length === 0) {
          warnings.push(`External MCP page visit produced no selectable chunks for ${item.url}.`);
          enriched.push(item);
          continue;
        }

        enriched.push(appendSelectedEvidenceChunks(item, selectedChunks));
      } catch (error) {
        warnings.push(`External MCP page visit failed for ${item.url}: ${error instanceof Error ? error.message : String(error)}`);
        enriched.push(item);
      }
    }

    return enriched;
  }
}

export async function callExternalMcpTool(call: ExternalMcpToolCall): Promise<unknown> {
  if (!call.command) {
    throw new Error("missing external MCP command");
  }

  const client = new Client(
    { name: "chat-newsletter-search-client", version: "0.1.0" },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: call.command,
    args: call.args,
    cwd: call.cwd,
    env: call.env,
    stderr: "pipe"
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(String(chunk));
  });

  try {
    await client.connect(transport, { timeout: call.timeoutMs });
    return await client.callTool(
      {
        name: call.toolName,
        arguments: call.toolArgs
      },
      undefined,
      { timeout: call.timeoutMs }
    );
  } catch (error) {
    const stderr = stderrChunks.join("").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(stderr ? `${message}; stderr: ${stderr}` : message);
  } finally {
    await transport.close();
    await client.close();
  }
}

export function normalizeMcpSearchResult(result: unknown, input: ContentSearchInput, maxResults = 6): ContentItem[] {
  const candidates = extractCandidateObjects(result).slice(0, maxResults);
  const items = candidates
    .map((candidate) => candidateToContentItem(candidate, input))
    .filter((item): item is ContentItem => Boolean(item));

  if (items.length > 0) {
    return items;
  }

  return extractTextBlocks(result)
    .flatMap(parseLinksFromText)
    .slice(0, maxResults)
    .map((candidate) => candidateToContentItem(candidate, input))
    .filter((item): item is ContentItem => Boolean(item));
}

export function extractFailureMessage(result: unknown): string | undefined {
  const texts = [
    ...extractTextBlocks(result),
    ...extractStructuredResultTexts(result)
  ];
  const failure = texts.find((text) => /(?:search failed|error|timeout|captcha|blocked)/i.test(text));
  return failure ? `External MCP search returned no links: ${failure.slice(0, 500)}` : undefined;
}

function candidateToContentItem(candidate: Record<string, unknown>, input: ContentSearchInput): ContentItem | undefined {
  const url = pickString(candidate, ["url", "link", "href"]);
  if (!url || !isHttpUrl(url)) {
    return undefined;
  }

  const title = cleanText(pickString(candidate, ["title", "name", "heading"]) ?? sourceNameFromUrl(url));
  const summary = cleanText(pickString(candidate, ["snippet", "description", "summary", "content", "text"]) ?? title);
  const imageUrl = pickString(candidate, ["imageUrl", "image_url", "image", "thumbnail", "thumbnailUrl"]);
  const publishedAt = toDateOnly(pickString(candidate, ["publishedAt", "published_date", "date", "datetime"]));
  if (publishedAt && !isWithinPeriod(publishedAt, input.period.start, input.period.end)) {
    return undefined;
  }

  const searchable = `${title} ${summary}`.toLocaleLowerCase();
  const matchedInterests = input.interests.filter((interest) => searchable.includes(interest.toLocaleLowerCase()));
  const matchedKeywords = input.keywords.filter((keyword) => searchable.includes(keyword.toLocaleLowerCase()));
  const matchedRegions = input.regions.filter((region) => searchable.includes(region.toLocaleLowerCase()));

  return {
    id: contentId(url),
    type: "news",
    title,
    summary,
    url,
    sourceName: pickString(candidate, ["sourceName", "source", "displayLink", "domain"]) ?? sourceNameFromUrl(url),
    imageUrl: imageUrl && isHttpUrl(imageUrl) ? imageUrl : undefined,
    imageAlt: imageUrl && isHttpUrl(imageUrl) ? title : undefined,
    publishedAt,
    interestTags: matchedInterests.length > 0 ? matchedInterests : input.interests,
    regions: matchedRegions,
    keywords: matchedKeywords.length > 0 ? matchedKeywords : input.keywords,
    evidence: [summary],
    sourceReliability: 0.62
  };
}

function extractCandidateObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }

  const structuredContent = value.structuredContent;
  if (structuredContent !== undefined) {
    const nested = extractCandidateObjects(structuredContent);
    if (nested.length > 0) {
      return nested;
    }
  }

  const toolResult = value.toolResult;
  if (toolResult !== undefined) {
    const nested = extractCandidateObjects(toolResult);
    if (nested.length > 0) {
      return nested;
    }
  }

  for (const key of ["results", "items", "organic_results", "organic", "data"]) {
    const nested = value[key];
    const candidates = extractCandidateObjects(nested);
    if (candidates.length > 0) {
      return candidates;
    }
  }

  for (const text of extractTextBlocks(value)) {
    const parsed = tryParseJson(text);
    const candidates = extractCandidateObjects(parsed);
    if (candidates.length > 0) {
      return candidates;
    }
  }

  return [];
}

function extractTextBlocks(value: unknown): string[] {
  if (!isRecord(value)) {
    return typeof value === "string" ? [value] : [];
  }
  const content = value.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : undefined)
    .filter((text): text is string => Boolean(text));
}

function extractVisitedPageText(result: unknown): string | undefined {
  const texts = uniqueStrings(extractReadableStrings(result));
  const combined = cleanText(texts.join("\n\n"));
  return combined || undefined;
}

function extractReadableStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractReadableStrings);
  }
  if (!isRecord(value)) {
    return [];
  }

  const texts: string[] = [];
  if (typeof value.text === "string") {
    texts.push(value.text);
  }
  for (const key of ["markdown", "body", "article", "result", "summary"]) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      texts.push(candidate);
    }
  }
  for (const key of ["content", "structuredContent", "toolResult", "data"]) {
    const nested = value[key];
    if (nested !== undefined) {
      texts.push(...extractReadableStrings(nested));
    }
  }
  return texts;
}

function extractStructuredResultTexts(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const texts: string[] = [];
  for (const key of ["result", "message", "error"]) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      texts.push(candidate);
    }
  }
  if (isRecord(value.structuredContent)) {
    texts.push(...extractStructuredResultTexts(value.structuredContent));
  }
  if (isRecord(value.toolResult)) {
    texts.push(...extractStructuredResultTexts(value.toolResult));
  }
  return texts;
}

function parseLinksFromText(text: string): Array<Record<string, unknown>> {
  const numberedResults = parseNumberedUrlResults(text);
  if (numberedResults.length > 0) {
    return numberedResults;
  }

  const results: Array<Record<string, unknown>> = [];
  const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)(?:\s*[-:]\s*([^\n]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = markdownLink.exec(text)) !== null) {
    results.push({
      title: match[1],
      url: match[2],
      snippet: match[3]
    });
  }

  if (results.length > 0) {
    return results;
  }

  const rawUrl = /(https?:\/\/\S+)/g;
  while ((match = rawUrl.exec(text)) !== null) {
    results.push({
      title: match[1],
      url: match[1],
      snippet: text.slice(Math.max(0, match.index - 80), match.index + match[1].length + 120)
    });
  }
  return results;
}

function parseNumberedUrlResults(text: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  let current: {
    title?: string;
    url?: string;
    sourceName?: string;
    snippetParts: string[];
  } | undefined;

  const flush = () => {
    if (!current?.url) {
      return;
    }
    results.push({
      title: current.title,
      url: current.url,
      sourceName: current.sourceName,
      snippet: current.snippetParts.join(" ")
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const titleMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (titleMatch) {
      flush();
      current = {
        title: titleMatch[1],
        snippetParts: []
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const urlMatch = trimmed.match(/^URL:\s*(https?:\/\/\S+)/i);
    if (urlMatch) {
      current.url = stripTrailingUrlPunctuation(urlMatch[1]);
      continue;
    }

    const sourceMatch = trimmed.match(/^Source:\s*(.+)$/i);
    if (sourceMatch) {
      current.sourceName = sourceMatch[1].split(/\s+-\s+/)[0]?.trim();
      continue;
    }

    if (!/^(Authors|Cited by):/i.test(trimmed)) {
      current.snippetParts.push(trimmed);
    }
  }

  flush();
  return results;
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[),.;]+$/, "");
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buildChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function buildQuery(input: ContentSearchInput): string {
  return [...new Set([
    ...input.interests,
    ...input.regions,
    ...input.keywords
  ].map((value) => value.trim()).filter(Boolean))]
    .slice(0, 12)
    .join(" ");
}

function pickString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const result = value[key];
    if (typeof result === "string" && result.trim()) {
      return result;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentId(url: string): string {
  return createHash("sha1").update(`external-mcp-search:${url}`).digest("hex").slice(0, 16);
}

function cleanText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function sourceNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "External MCP Search";
  }
}

function toDateOnly(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

function isWithinPeriod(dateOnly: string, start: string, end: string): boolean {
  return dateOnly >= start && dateOnly <= end;
}
