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
WEB_SEARCH_PROVIDER=all
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

NOAPI_GOOGLE_SEARCH_COMMAND=
NOAPI_GOOGLE_SEARCH_ARGS=
NOAPI_GOOGLE_SEARCH_TOOL_NAME=search
NOAPI_GOOGLE_SEARCH_QUERY_PARAM=query
NOAPI_GOOGLE_SEARCH_MAX_RESULTS_PARAM=maxResults
ENABLE_NOAPI_GOOGLE_SEARCH=false
```

`TAVILY_API_KEY` is enough to enable the Tavily provider. `ENABLE_WEB_SEARCH=true` can be used to force registration and surface a warning when the key is missing.

For an external MCP search provider, configure either the generic `EXTERNAL_MCP_SEARCH_*` variables or the no-API Google aliases `NOAPI_GOOGLE_SEARCH_*`. The server spawns the configured MCP server over stdio, calls the configured search tool, and normalizes returned links or structured results into `ContentItem` records.

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
NOAPI_GOOGLE_SEARCH_COMMAND=node
NOAPI_GOOGLE_SEARCH_ARGS='["path/to/noapi-google-search-mcp.js"]'
NOAPI_GOOGLE_SEARCH_TOOL_NAME=search
npm run dev
```

You can also run the live generic-search comparison test. It does not call domain-specific API connectors; it only calls Tavily and the configured external Google MCP search provider with the same query, then prints provider counts, top domains, top results, and overlapping URLs:

```bash
RUN_SEARCH_COMPARISON=true
TAVILY_API_KEY=...
NOAPI_GOOGLE_SEARCH_COMMAND=node
NOAPI_GOOGLE_SEARCH_ARGS='["path/to/noapi-google-search-mcp.js"]'
NOAPI_GOOGLE_SEARCH_TOOL_NAME=search
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
