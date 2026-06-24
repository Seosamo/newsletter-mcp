# Web Search and HTML Extraction

The MCP server now supports optional web search in addition to RSS and mock providers.

## How it works

1. `WebSearchProvider` sends the user's interests, regions, and keywords to Brave Search.
2. The provider receives candidate URLs.
3. `HtmlArticleExtractor` fetches the top pages and extracts basic metadata and readable text.
4. Results are normalized into the existing `ContentItem` shape.
5. The existing filtering, deduplication, ranking, and Markdown formatting pipeline handles them with RSS/mock items.

This is intentionally not a general-purpose crawler. It only fetches a small number of search result pages per newsletter request.

## Environment variables

```bash
BRAVE_SEARCH_API_KEY=...
ENABLE_WEB_SEARCH=true
WEB_SEARCH_MAX_RESULTS=6
WEB_SEARCH_MAX_PAGES_TO_EXTRACT=3
WEB_SEARCH_EXTRACT_HTML=true
WEB_SEARCH_TIMEOUT_MS=8000
HTML_EXTRACT_TIMEOUT_MS=8000
HTML_EXTRACT_MAX_TEXT_CHARS=5000
WEB_SEARCH_ALLOWED_DOMAINS=
WEB_SEARCH_BLOCKED_DOMAINS=
```

`BRAVE_SEARCH_API_KEY` is enough to enable the provider. `ENABLE_WEB_SEARCH=true` can be used to force registration and surface a warning when the key is missing.

To inspect real web results without mock content mixed in:

```bash
ENABLE_MOCK_PROVIDERS=false
BRAVE_SEARCH_API_KEY=...
npm run dev
```

## Example request

```json
{
  "userId": "default",
  "userMessage": "Create this week's Japan economy newsletter.",
  "interests": ["Japan economy"],
  "regions": ["Japan"],
  "period": {
    "start": "2026-06-15",
    "end": "2026-06-23"
  }
}
```

Expected output in the Markdown newsletter draft:

- Web search result titles as `top_stories`
- Extracted summaries from search snippets and article HTML
- Source links pointing to the original pages
- Warnings when search or extraction fails

## Safety controls

- Results are limited by `WEB_SEARCH_MAX_RESULTS`.
- HTML extraction is limited by `WEB_SEARCH_MAX_PAGES_TO_EXTRACT`.
- Each fetch has a timeout.
- Optional allow/block domain lists can restrict extraction targets.
- RSS and existing mock providers remain modular and independent.
