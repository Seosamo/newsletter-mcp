import { createHash } from "node:crypto";
import type { ApiCatalogEntry, ApiCatalogFile, ApiCatalogSource } from "./types.js";
import { DEFAULT_API_CATALOG_ENTRIES } from "./defaultApiCatalog.js";

export function parseApiCatalogMarkdown(markdown: string, source: ApiCatalogSource): ApiCatalogEntry[] {
  const entries: ApiCatalogEntry[] = [];
  let category = "uncategorized";

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{3,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      category = normalizeText(heading[1])
        .replace(/^⬆.*$/u, "uncategorized")
        .replace(/\s+/g, "-")
        .toLocaleLowerCase();
      continue;
    }

    if (!line.trim().startsWith("|") || /^\|\s*:?-+/.test(line) || /\|\s*API\s*\|/.test(line)) {
      continue;
    }

    const cells = splitMarkdownRow(line);
    if (cells.length < 3) {
      continue;
    }

    const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(cells[0]);
    if (!link) {
      continue;
    }

    const name = normalizeText(link[1]);
    const url = normalizeText(link[2]);
    const description = normalizeText(cells[1]);
    const auth = normalizeText(cells[2]) || "Unknown";
    const https = normalizeYesNo(cells[3]);
    const cors = normalizeYesNo(cells[4]);
    const connectorId = inferConnectorId(name, url, description);

    entries.push({
      id: stableId(source, category, name, url),
      name,
      category,
      description,
      url,
      auth,
      https,
      cors,
      source,
      keywords: buildKeywords(category, name, description),
      connectorId
    });
  }

  return dedupeEntries(entries);
}

export function buildCatalogFile(inputs: Array<{ url: string; source: ApiCatalogSource; markdown: string }>): ApiCatalogFile {
  const parsedEntries = inputs.flatMap((input) => parseApiCatalogMarkdown(input.markdown, input.source));
  const entries = dedupeEntries([...parsedEntries, ...DEFAULT_API_CATALOG_ENTRIES]);
  return {
    generatedAt: new Date().toISOString(),
    sources: inputs.map((input) => input.url),
    entries
  };
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => normalizeText(cell));
}

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeYesNo(value: string | undefined): "Yes" | "No" | "Unknown" {
  const normalized = normalizeText(value ?? "").toLocaleLowerCase();
  if (normalized === "yes") return "Yes";
  if (normalized === "no") return "No";
  return "Unknown";
}

function stableId(source: ApiCatalogSource, category: string, name: string, url: string): string {
  return createHash("sha1").update(`${source}:${category}:${name}:${url}`).digest("hex").slice(0, 16);
}

function buildKeywords(category: string, name: string, description: string): string[] {
  const raw = `${category} ${name} ${description}`.toLocaleLowerCase();
  const words = raw
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  return [...new Set(words)].slice(0, 24);
}

function inferConnectorId(name: string, url: string, description: string): string | undefined {
  const haystack = `${name} ${url} ${description}`.toLocaleLowerCase();
  if (haystack.includes("tourapi") || haystack.includes("visitkorea")) return "tourapi";
  if (haystack.includes("culture.go.kr") || haystack.includes("문화정보")) return "culture_info";
  if (haystack.includes("eventbrite")) return "eventbrite";
  if (haystack.includes("ticketmaster")) return "ticketmaster";
  if (haystack.includes("기상청") || haystack.includes("meteorological")) return "kma_weather";
  if (haystack.includes("openaq")) return "openaq";
  return undefined;
}

function dedupeEntries(entries: ApiCatalogEntry[]): ApiCatalogEntry[] {
  const seen = new Set<string>();
  const deduped: ApiCatalogEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.name.toLocaleLowerCase()}|${entry.url.toLocaleLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}
