import type { ContentItem, SourcePreference } from "../domain/types.js";

export type SourcePreferenceInput = Partial<SourcePreference>;

export function normalizeSourcePreferences(values: SourcePreferenceInput[] | undefined): SourcePreference[] {
  return mergeSourcePreferences(...(values ?? []).map((value) => {
    const label = value.label?.trim() || labelFromFirstValue([
      ...(value.domains ?? []),
      ...(value.rssUrls ?? []),
      ...(value.queryHints ?? [])
    ]);
    if (!label) {
      return [];
    }
    return [{
      label,
      domains: normalizeDomains(value.domains ?? []),
      rssUrls: normalizeHttpUrls(value.rssUrls ?? []).filter(isLikelyRssUrl),
      queryHints: normalizeList(value.queryHints ?? []),
      weight: clamp(value.weight ?? 1.25, 0, 2),
      enabled: value.enabled ?? true
    }];
  }));
}

export function normalizeSourceLinks(links: string[] | undefined): SourcePreference[] {
  return mergeSourcePreferences(...(links ?? []).map((link) => {
    const preference = sourcePreferenceFromLink(link);
    return preference ? [preference] : [];
  }));
}

export function sourcePreferencesFromHints(hints: string[] | undefined): SourcePreference[] {
  return mergeSourcePreferences(...(hints ?? []).map((hint) => {
    const trimmed = hint.trim();
    if (!trimmed) {
      return [];
    }

    const fromLink = sourcePreferenceFromLink(trimmed);
    if (fromLink) {
      return [fromLink];
    }

    const domain = normalizeDomain(trimmed);
    if (domain) {
      return [{
        label: labelFromDomain(domain),
        domains: [domain],
        rssUrls: [],
        queryHints: [`site:${domain}`],
        weight: 1.25,
        enabled: true
      }];
    }

    return [{
      label: trimmed,
      domains: [],
      rssUrls: [],
      queryHints: [trimmed],
      weight: 1.1,
      enabled: true
    }];
  }));
}

export function mergeSourcePreferences(...groups: SourcePreference[][]): SourcePreference[] {
  const byKey = new Map<string, SourcePreference>();

  for (const preference of groups.flat()) {
    if (!preference.enabled) {
      continue;
    }
    const normalized = {
      ...preference,
      label: preference.label.trim(),
      domains: normalizeDomains(preference.domains),
      rssUrls: normalizeHttpUrls(preference.rssUrls).filter(isLikelyRssUrl),
      queryHints: normalizeList(preference.queryHints),
      weight: clamp(preference.weight, 0, 2),
      enabled: preference.enabled
    };
    if (!normalized.label) {
      continue;
    }

    const key = sourcePreferenceKey(normalized);
    const existing = byKey.get(key);
    byKey.set(key, existing ? {
      label: existing.label || normalized.label,
      domains: unique([...existing.domains, ...normalized.domains]),
      rssUrls: unique([...existing.rssUrls, ...normalized.rssUrls]),
      queryHints: unique([...existing.queryHints, ...normalized.queryHints]),
      weight: Math.max(existing.weight, normalized.weight),
      enabled: existing.enabled || normalized.enabled
    } : normalized);
  }

  return [...byKey.values()];
}

export function sourcePreferenceFromLink(link: string): SourcePreference | undefined {
  let parsed: URL;
  try {
    parsed = new URL(link.trim());
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  const domain = normalizeDomain(parsed.hostname);
  if (!domain) {
    return undefined;
  }

  const url = parsed.toString();
  return {
    label: labelFromDomain(domain),
    domains: [domain],
    rssUrls: isLikelyRssUrl(url) ? [url] : [],
    queryHints: [`site:${domain}`],
    weight: 1.25,
    enabled: true
  };
}

export function findMatchingSourcePreference(
  item: Pick<ContentItem, "url" | "sourceName">,
  preferences: SourcePreference[] | undefined
): SourcePreference | undefined {
  const enabled = (preferences ?? []).filter((preference) => preference.enabled);
  if (enabled.length === 0) {
    return undefined;
  }

  const itemDomain = item.url ? domainFromUrl(item.url) : undefined;
  const sourceName = item.sourceName?.toLocaleLowerCase();

  return enabled.find((preference) => {
    const domains = normalizeDomains(preference.domains);
    const label = preference.label.toLocaleLowerCase();
    if (itemDomain && domains.some((domain) => itemDomain === domain || itemDomain.endsWith(`.${domain}`))) {
      return true;
    }
    return Boolean(sourceName && (sourceName.includes(label) || domains.some((domain) => sourceName.includes(domain))));
  });
}

export function preferredDomains(preferences: SourcePreference[] | undefined): string[] {
  return unique((preferences ?? [])
    .filter((preference) => preference.enabled)
    .flatMap((preference) => normalizeDomains(preference.domains)));
}

export function preferredRssUrls(preferences: SourcePreference[] | undefined): string[] {
  return unique((preferences ?? [])
    .filter((preference) => preference.enabled)
    .flatMap((preference) => normalizeHttpUrls(preference.rssUrls).filter(isLikelyRssUrl)));
}

export function preferredQueryHints(preferences: SourcePreference[] | undefined): string[] {
  const enabled = (preferences ?? []).filter((preference) => preference.enabled);
  return unique([
    ...enabled.flatMap((preference) => preference.queryHints),
    ...enabled.flatMap((preference) => preference.domains.map((domain) => `site:${normalizeDomain(domain)}`))
  ].filter((hint): hint is string => Boolean(hint)));
}

export function normalizeDomain(value: string): string | undefined {
  const trimmed = value.trim().toLocaleLowerCase();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, "");
  } catch {
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed)) {
      return trimmed.replace(/^www\./, "");
    }
    return undefined;
  }
}

function domainFromUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLocaleLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function sourcePreferenceKey(preference: SourcePreference): string {
  return preference.domains[0] ?? preference.rssUrls[0] ?? preference.label.toLocaleLowerCase();
}

function labelFromFirstValue(values: string[]): string {
  const first = values.map((value) => value.trim()).find(Boolean);
  if (!first) {
    return "";
  }
  const domain = normalizeDomain(first);
  return domain ? labelFromDomain(domain) : first;
}

function labelFromDomain(domain: string): string {
  return domain
    .split(".")
    .filter((part) => !["com", "org", "net", "io", "co", "kr"].includes(part))
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ") || domain;
}

function isLikelyRssUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLocaleLowerCase();
    return /(?:rss|feed|atom|xml)(?:\/|$|\.)/.test(pathname);
  } catch {
    return false;
  }
}

function normalizeHttpUrls(values: string[]): string[] {
  return unique(values.flatMap((value) => {
    try {
      const url = new URL(value.trim());
      return url.protocol === "http:" || url.protocol === "https:" ? [url.toString()] : [];
    } catch {
      return [];
    }
  }));
}

function normalizeDomains(values: string[]): string[] {
  return unique(values.flatMap((value) => {
    const domain = normalizeDomain(value);
    return domain ? [domain] : [];
  }));
}

function normalizeList(values: string[]): string[] {
  return unique(values.map((value) => value.trim()).filter(Boolean));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
