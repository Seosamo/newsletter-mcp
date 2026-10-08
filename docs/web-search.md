# 웹 검색 및 본문 수집

[README로 돌아가기 (∩ ͡° ͜ʖ ͡° )⊃━☆ﾟ](../README.md)

Tavily나 외부 검색 MCP를 활용하여 웹 검색 및 본문 수집 설정을 하는 부분입니다.

## 동작 과정

1. `WebSearchProvider`가 사용자의 관심사, 지역, 키워드를 Tavily Search에 전달
2. 외부 검색 MCP를 설정했다면 `ExternalMcpSearchProvider`가 해당 서버를 호출 (본 프로젝트의 경우 `noapi-google-search-mcp`를 연결했습니다)
3. 각 검색 provider가 결과 URL을 수집
4. Tavily 결과 중 상위 페이지는 `HtmlArticleExtractor`로 메타데이터와 본문을 추출
5. 수집한 결과를 공통 데이터 형식인 `ContentItem`으로 변환
6. RSS와 mock 데이터에 사용하는 파이프라인에서 함께 필터링, 중복 제거, 정렬을 거쳐 Markdown 초안으로 생성

참고) 뉴스레터 요청마다 검색 결과의 전체 페이지가 아닌 일부 페이지만 가져옵니다

ㅤ

## 환경 변수

사용할 검색 서비스에 맞춰 프로젝트 루트의 `.env`에 설정합니다. 
* 아래 예시에서 `WEB_SEARCH_PROVIDER`는 `noapi_google_search`로 지정되어 있습니다. 
* Tavily만 사용하려면 `tavily`, 두 검색 서비스를 함께 사용하려면 `all`로 변경하세요.

```dotenv
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

* `WEB_SEARCH_PROVIDER`가 Tavily 사용을 허용하는 경우 `TAVILY_API_KEY`를 설정하면 Tavily provider가 활성화됩니다. `ENABLE_WEB_SEARCH=true`로 강제 등록하면 API 키가 없을 때도 설정 누락 경고를 확인할 수 있습니다.

* 외부 검색 MCP는 공통 설정인 `EXTERNAL_MCP_SEARCH_*` 또는 no-API Google용 `NOAPI_GOOGLE_SEARCH_*` 변수로 연결합니다. 서버는 설정된 MCP 서버를 stdio 방식으로 실행하고, 지정한 검색 도구의 응답을 `ContentItem`으로 변환합니다.

* no-API Google 설정의 기본 도구 이름은 `google_search`, 검색어와 결과 수 인자는 각각 `query`, `num_results`입니다. 공통 설정의 기본값은 각각 `search`, `query`, `maxResults`입니다.

ㅤ
## noapi-google-search-mcp 연결

외부 MCP 서버와 실행에 필요한 Chromium을 설치합니다.

```bash
pipx install noapi-google-search-mcp
playwright install chromium
```

다음 값을 `.env`에 설정합니다. 검색 결과 수와 본문 수집량은 조정할 수 있습니다.

```dotenv
WEB_SEARCH_PROVIDER=noapi_google_search
NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp
NOAPI_GOOGLE_SEARCH_MAX_RESULTS=6
NOAPI_GOOGLE_SEARCH_MAX_PAGES_TO_VISIT=3
NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE=1
NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_TOTAL=3
ENABLE_MOCK_PROVIDERS=false
```

설정 후 서버를 실행합니다.

```bash
npm run dev
```

`NOAPI_GOOGLE_SEARCH_TOOL_NAME`, `NOAPI_GOOGLE_SEARCH_QUERY_PARAM`, `NOAPI_GOOGLE_SEARCH_MAX_RESULTS_PARAM`은 생략 가능합니다. (이 프로젝트에서 사용하는 기본값은 각각 `google_search`, `query`, `num_results`입니다)

`NOAPI_GOOGLE_SEARCH_VISIT_PAGES`는 기본적으로 활성화되어 있습니다. 
* URL과 검색 결과 요약만 사용하려면 `false`로 설정하면 됩니다
* 본문 수집이 오래 걸리면 `NOAPI_GOOGLE_SEARCH_MAX_PAGES_TO_VISIT` 값을 줄일 수 있습니다.

현재 chunk 선택은 임시로 가운데 부분을 고르는 방식에 해당합니다 (관련도를 기준으로 선택하는 방식으로 교체할 수 있도록 선택 로직이 별도로 분리되어 있습니다!)

ㅤ
## 검색 결과 확인 및 비교

실제 웹 검색 결과만 확인하려면 `.env`에서 mock을 끄고 사용할 검색 서비스를 설정합니다. 

아래는 Tavily를 사용하는 예시입니다. (설정을 바꾼 뒤에는 서버를 다시 실행하셔야 합니다)

```dotenv
ENABLE_MOCK_PROVIDERS=false
WEB_SEARCH_PROVIDER=all
TAVILY_API_KEY=...
```

Tavily와 외부 검색 MCP의 결과를 함께 확인하려면 두 서비스 모두 설정합니다.

```dotenv
WEB_SEARCH_PROVIDER=all
TAVILY_API_KEY=...
NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp
```

실제 검색 서비스를 호출하는 비교 테스트도 있습니다. 같은 검색어를 Tavily와 외부 Google 검색 MCP에 전달하고, 서비스별 결과 수, 주요 도메인, 상위 결과, 중복 URL을 출력합니다. (이때 도메인별 API 커넥터는 호출하지 않습니다) 

다음 환경변수를 `.env`에 설정합니다.

```dotenv
RUN_SEARCH_COMPARISON=true
TAVILY_API_KEY=...
NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp
```

이후 테스트를 실행합니다.

```bash
npm run test:search-comparison
```

검색어, 기간, 결과 수를 직접 지정하려면 다음 설정을 추가하시면 됩니다.

```dotenv
SEARCH_COMPARISON_QUERY="latest Japan economy news"
SEARCH_COMPARISON_START=2026-06-18
SEARCH_COMPARISON_END=2026-06-25
SEARCH_COMPARISON_MAX_RESULTS=8
```

ㅤ
## 요청 예시

검색 서비스를 연결한 상태에서 `generate_newsletter_draft`에 다음 인자를 전달할 수 있습니다.

```json
{
  "userId": "default",
  "userMessage": "이번 주 일본 경제 소식으로 뉴스레터 만들어줘.",
  "interests": ["일본 경제"],
  "regions": ["일본"],
  "period": {
    "start": "2026-06-15",
    "end": "2026-06-23"
  }
}
```

생성된 Markdown 초안에서는 다음 내용을 확인할 수 있습니다.

- `top_stories` 섹션에 배치된 검색 결과
- 검색 결과 요약과 기사 HTML에서 추출한 내용
- 원문으로 연결되는 출처 링크
- 검색이나 본문 추출에 실패했을 때의 경고

ㅤ
## 수집 범위와 제한

- `WEB_SEARCH_MAX_RESULTS`로 검색 결과 수를 제한합니다.
- `WEB_SEARCH_MAX_PAGES_TO_EXTRACT`로 HTML 본문을 추출할 페이지 수를 제한합니다.
- 각 요청에는 timeout을 적용합니다.
- 허용·차단 도메인 목록을 설정해 본문 수집 대상을 제한할 수 있습니다.
- RSS와 mock provider는 각각 독립된 모듈로 동작합니다.
