# Web Search and HTML Extraction

The MCP server now supports optional web search in addition to RSS and mock providers.

## How it works

1. `WebSearchProvider` sends the user's interests, regions, and keywords to Tavily Search.
2. `ExternalMcpSearchProvider` can call a separate search MCP server, such as a no-API Google search MCP server, when configured.
3. Each provider receives candidate URLs.
4. `HtmlArticleExtractor` fetches the top pages from Tavily results and extracts basic metadata and readable text.
5. Results are normalized into the existing `ContentItem` shape.
6. The existing filtering, deduplication, ranking, and Markdown formatting pipeline handles them with RSS/mock items.

This is intentionally not a general-purpose crawler. It only fetches a small number of search result pages per newsletter request.

## Environment variables

```bash
WEB_SEARCH_PROVIDER=noapi_google_search
TAVILY_API_KEY=...
TAVILY_SEARCH_API_URL=https://api.tavily.com/search
TAVILY_SEARCH_TOPIC=news
TAVILY_SEARCH_DEPTH=basic
TAVILY_INCLUDE_RAW_CONTENT=false
WEB_SEARCH_MAX_RESULTS=6
WEB_SEARCH_MAX_PAGES_TO_EXTRACT=3
WEB_SEARCH_EXTRACT_HTML=true
WEB_SEARCH_TIMEOUT_MS=8000
HTML_EXTRACT_TIMEOUT_MS=8000
HTML_EXTRACT_MAX_TEXT_CHARS=5000
WEB_SEARCH_ALLOWED_DOMAINS=
WEB_SEARCH_BLOCKED_DOMAINS=

NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp
NOAPI_GOOGLE_SEARCH_ARGS=
NOAPI_GOOGLE_SEARCH_TOOL_NAME=google_search
NOAPI_GOOGLE_SEARCH_QUERY_PARAM=query
NOAPI_GOOGLE_SEARCH_MAX_RESULTS_PARAM=num_results
NOAPI_GOOGLE_SEARCH_MAX_RESULTS=6
NOAPI_GOOGLE_SEARCH_VISIT_PAGES=true
NOAPI_GOOGLE_SEARCH_VISIT_PAGE_TOOL_NAME=visit_page
NOAPI_GOOGLE_SEARCH_VISIT_PAGE_URL_PARAM=url
NOAPI_GOOGLE_SEARCH_MAX_PAGES_TO_VISIT=3
NOAPI_GOOGLE_SEARCH_PAGE_CONTENT_MAX_CHARS=1800
NOAPI_GOOGLE_SEARCH_PAGE_CHUNK_MAX_CHARS=1800
NOAPI_GOOGLE_SEARCH_PAGE_CHUNK_OVERLAP_CHARS=200
NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE=1
NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_TOTAL=3
ENABLE_NOAPI_GOOGLE_SEARCH=false
ENABLE_MOCK_PROVIDERS=false
```

`TAVILY_API_KEY` is enough to enable the Tavily provider. `ENABLE_WEB_SEARCH=true` can be used to force registration and surface a warning when the key is missing.

For an external MCP search provider, configure either the generic `EXTERNAL_MCP_SEARCH_*` variables or the no-API Google aliases `NOAPI_GOOGLE_SEARCH_*`. The server spawns the configured MCP server over stdio, calls one configured search tool, and normalizes returned links or structured results into `ContentItem` records. The no-API Google aliases default to `google_search` with `query` and `num_results`; generic `EXTERNAL_MCP_SEARCH_*` defaults stay `search`, `query`, and `maxResults`.

Only the configured search tool is called from this server while generating newsletter drafts. For the no-API Google aliases, the server also calls `visit_page` for the top search result URLs, chunks the readable page text, temporarily selects the middle chunk from each page, and appends selected chunks under each result summary. The child MCP server's other tools, such as local file, email, OCR, media, or S3 tools, are not registered in this server's `tools/list`.

## noapi-google-search-mcp setup

Install the external MCP server and its Chromium runtime:

```bash
pipx install noapi-google-search-mcp
playwright install chromium
```

These values are now the built-in defaults. You only need to set them when overriding the defaults:

```bash
WEB_SEARCH_PROVIDER=noapi_google_search
NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp
NOAPI_GOOGLE_SEARCH_MAX_RESULTS=6
NOAPI_GOOGLE_SEARCH_MAX_PAGES_TO_VISIT=3
NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE=1
NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_TOTAL=3
ENABLE_MOCK_PROVIDERS=false
npm run dev
```

`NOAPI_GOOGLE_SEARCH_TOOL_NAME`, `NOAPI_GOOGLE_SEARCH_QUERY_PARAM`, and `NOAPI_GOOGLE_SEARCH_MAX_RESULTS_PARAM` can be omitted for this package because this project defaults them to `google_search`, `query`, and `num_results`.

`NOAPI_GOOGLE_SEARCH_VISIT_PAGES` defaults to enabled. Set it to `false` to keep URL/snippet-only behavior, or lower `NOAPI_GOOGLE_SEARCH_MAX_PAGES_TO_VISIT` if page fetching is too slow.

Chunk selection is intentionally temporary: each visited page is chunked and the middle chunk is selected for now. The selector is isolated in code so the next step can replace it with relevance-based selection.

To inspect real web results without mock content mixed in:

```bash
ENABLE_MOCK_PROVIDERS=false
WEB_SEARCH_PROVIDER=all
TAVILY_API_KEY=...
npm run dev
```

To compare Tavily and an external search MCP side-by-side, configure both providers:

```bash
WEB_SEARCH_PROVIDER=all
TAVILY_API_KEY=...
NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp
npm run dev
```

You can also run the live generic-search comparison test. It does not call domain-specific API connectors; it only calls Tavily and the configured external Google MCP search provider with the same query, then prints provider counts, top domains, top results, and overlapping URLs:

```bash
RUN_SEARCH_COMPARISON=true
TAVILY_API_KEY=...
NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp
npm run test:search-comparison
```

Optional comparison inputs:

```bash
SEARCH_COMPARISON_QUERY="latest Japan economy news"
SEARCH_COMPARISON_START=2026-06-18
SEARCH_COMPARISON_END=2026-06-25
SEARCH_COMPARISON_MAX_RESULTS=8
```

## Example request

Newsletter generation with the configured search backend:

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
