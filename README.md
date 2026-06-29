# Chat Newsletter MCP

> PlayMCP in KC 배포는 루트 `Dockerfile` 기반 Git 소스 빌드를 지원합니다. 단계별 안내는 [docs/playmcp-deploy.md](docs/playmcp-deploy.md)를 참고하세요.

채팅 기반 사용자 관심사를 받아 Markdown 형식의 뉴스레터를 생성하는 MCP 서버입니다.

사용자 선호도 관리, 콘텐츠 수집·랭킹·중복 제거, 뉴스레터 템플릿 매핑까지 전 과정을 처리합니다. 모든 툴 응답은 TextContent(Markdown) 형식으로 반환됩니다.

---

## MCP란?

**MCP(Model Context Protocol)**는 LLM 클라이언트(예: Claude)가 외부 서버의 기능을 표준화된 방식으로 호출할 수 있도록 만든 오픈 프로토콜입니다.

```
LLM 클라이언트 ──(MCP 프로토콜)──▶ MCP 서버 ──▶ 비즈니스 로직 / 데이터
```

MCP 서버는 **툴(Tool)** 목록을 클라이언트에 노출하고, 클라이언트가 JSON-RPC 메시지로 툴을 호출하면 서버가 결과를 반환합니다. 이 서버는 Streamable HTTP 전송 방식만 지원합니다(`stdio`, 구버전 HTTP+SSE 미지원).

지원 프로토콜 버전: `2025-03-26`, `2025-06-18`, `2025-11-25`

---

## MCP Tools

| 툴 이름 | 설명 | 읽기전용 |
|---|---|:---:|
| `get_user_profile` | 사용자 뉴스레터 선호도 프로파일 조회 | ✓ |
| `update_user_preferences` | 채팅에서 파싱된 선호도 업데이트 | |
| `list_newsletter_templates` | 사용 가능한 템플릿 목록 조회 | ✓ |
| `get_newsletter_template` | 특정 템플릿 조회 | ✓ |
| `upsert_newsletter_template` | 채팅에서 구조화한 뉴스레터 작성 템플릿 저장/갱신 | |
| `list_user_category_settings` | 사용자 관심 태그 설정 목록 조회 | ✓ |
| `upsert_user_category_setting` | 관심 태그 메타데이터 생성/교체 | |
| `list_newsletter_history` | 최근 생성된 뉴스레터 초안 이력 조회 | ✓ |
| `generate_newsletter_draft` | 채팅 선호도 기반 뉴스레터 생성 (Markdown 반환) | |
| `recommend_api_connectors` | 사용자 관심사에 맞는 public API 후보와 지원 여부 추천 | ✓ |

> 채팅 파싱(관심사 추출 등)은 LLM 클라이언트 측에서 처리한 뒤 툴을 호출합니다.
> 서버는 LLM API를 직접 호출하지 않고, 근거 데이터와 Markdown 초안을 반환합니다.

사용자 정의 뉴스레터 포맷은 `upsert_newsletter_template`로 저장하고, 생성 시 `generate_newsletter_draft`의 `templateId`로 선택합니다. 생성 결과에는 `AI Editing Instructions`가 함께 포함되어 LLM 클라이언트가 저장된 템플릿 규칙대로 최종 뉴스레터를 작성할 수 있습니다.

---

## 설치 및 실행

```bash
npm install
npm run build
```

로컬 개발 서버 실행 (Streamable HTTP):

```bash
npm run dev
```

기본 엔드포인트:

```
http://127.0.0.1:3000/mcp
```

데이터 디렉터리 변경:

```bash
NEWSLETTER_MCP_DATA_DIR=/path/to/data npm run dev
```

프로젝트 루트의 `.env` 파일은 서버 시작 시 자동으로 로드됩니다. 이미 쉘에 설정된 환경변수는 `.env` 값으로 덮어쓰지 않습니다.

---

## 환경 변수

### 프로덕션 배포

| 변수 | 설명 |
|---|---|
| `NODE_ENV` | `production` 으로 설정 |
| `HOST` | 바인딩 호스트 (예: `0.0.0.0`) |
| `PORT` | 포트 번호 |
| `PUBLIC_BASE_URL` | 외부 공개 도메인 |
| `MCP_ENDPOINT_PATH` | MCP 엔드포인트 경로 (기본: `/mcp`) |
| `ALLOWED_ORIGINS` | 허용할 클라이언트 오리진 |
| `NEWSLETTER_MCP_AUTH_TOKEN` | 인증 토큰 (설정 시 활성화) |

인증 토큰이 설정된 경우 아래 헤더 중 하나로 전달합니다:

```
Authorization: Bearer <token>
X-MCP-Auth: <token>
```

### 콘텐츠 수집

| 변수 | 설명 |
|---|---|
| `ENABLE_DOMAIN_CONNECTORS` | `false`면 public API 기반 도메인 커넥터 비활성화 |
| `DOMAIN_CONNECTOR_MAX_CONNECTORS` | draft 생성 시 시도할 도메인 커넥터 수 |
| `TOUR_API_KEY` | 한국관광공사 TourAPI 호출 키 |
| `CULTURE_INFO_API_URL` / `CULTURE_INFO_API_KEY` | 문화정보 계열 API 호출 설정 |
| `EVENTBRITE_TOKEN` | Eventbrite API 호출 토큰 |
| `TICKETMASTER_API_KEY` | Ticketmaster Discovery API 호출 키 |
| `KMA_API_URL` / `KMA_API_KEY` | 기상청 계열 API 호출 설정 |
| `OPENAQ_API_KEY` | OpenAQ API 호출 키 |
| `WEB_SEARCH_PROVIDER` | `all`, `tavily`, `external_mcp`, `noapi_google_search`, `none` 중 선택 |
| `TAVILY_API_KEY` | Tavily 기반 웹 검색 provider 활성화 |
| `TAVILY_SEARCH_API_URL` | Tavily 호환 검색 endpoint (기본: `https://api.tavily.com/search`) |
| `TAVILY_SEARCH_TOPIC` | Tavily topic: `general`, `news`, `finance` |
| `TAVILY_SEARCH_DEPTH` | Tavily search depth: `basic`, `advanced`, `fast`, `ultra-fast` |
| `TAVILY_INCLUDE_RAW_CONTENT` | Tavily raw content 포함 여부: `false`, `true`, `markdown`, `text` |
| `WEB_SEARCH_PAGE_CHUNK_MAX_CHARS` | Tavily/HTML 본문 chunk 최대 길이 (기본: `1800`) |
| `WEB_SEARCH_PAGE_CHUNK_OVERLAP_CHARS` | Tavily/HTML 본문 chunk 간 overlap 길이 (기본: `200`) |
| `WEB_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE` | Tavily/HTML 페이지별 선택 evidence chunk 수 (기본: `2`) |
| `WEB_SEARCH_MAX_SELECTED_CHUNKS_TOTAL` | Tavily/HTML 전체 선택 evidence chunk 수 (기본: `8`) |
| `ENABLE_WEB_SEARCH` | `true`면 Tavily provider를 강제 등록해 설정 누락 warning 확인 |
| `EXTERNAL_MCP_SEARCH_COMMAND` / `NOAPI_GOOGLE_SEARCH_COMMAND` | 외부 검색 MCP 서버 실행 명령 |
| `EXTERNAL_MCP_SEARCH_ARGS` / `NOAPI_GOOGLE_SEARCH_ARGS` | 외부 검색 MCP 서버 실행 인자 |
| `EXTERNAL_MCP_SEARCH_TOOL_NAME` / `NOAPI_GOOGLE_SEARCH_TOOL_NAME` | 호출할 외부 MCP 검색 tool 이름 (generic default: `search`, noapi default: `google_search`) |
| `EXTERNAL_MCP_SEARCH_QUERY_PARAM` / `NOAPI_GOOGLE_SEARCH_QUERY_PARAM` | 검색어 파라미터 이름 (기본: `query`) |
| `EXTERNAL_MCP_SEARCH_MAX_RESULTS_PARAM` / `NOAPI_GOOGLE_SEARCH_MAX_RESULTS_PARAM` | 결과 수 파라미터 이름 (generic default: `maxResults`, noapi default: `num_results`) |
| `EXTERNAL_MCP_SEARCH_VISIT_PAGES` / `NOAPI_GOOGLE_SEARCH_VISIT_PAGES` | 검색 결과 URL 본문 fetch 여부 (noapi default: `true`) |
| `EXTERNAL_MCP_SEARCH_MAX_PAGES_TO_VISIT` / `NOAPI_GOOGLE_SEARCH_MAX_PAGES_TO_VISIT` | 본문 fetch 대상 검색 결과 수 (기본: `3`) |
| `EXTERNAL_MCP_SEARCH_PAGE_CHUNK_MAX_CHARS` / `NOAPI_GOOGLE_SEARCH_PAGE_CHUNK_MAX_CHARS` | 방문 페이지 chunk 최대 길이 (기본: `1800`) |
| `EXTERNAL_MCP_SEARCH_PAGE_CHUNK_OVERLAP_CHARS` / `NOAPI_GOOGLE_SEARCH_PAGE_CHUNK_OVERLAP_CHARS` | 방문 페이지 chunk 간 overlap 길이 (기본: `200`) |
| `EXTERNAL_MCP_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE` / `NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE` | 페이지별 선택 evidence chunk 수 (기본: `2`) |
| `EXTERNAL_MCP_SEARCH_MAX_SELECTED_CHUNKS_TOTAL` / `NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_TOTAL` | 전체 선택 evidence chunk 수 (기본: `8`) |
| `ENABLE_EXTERNAL_MCP_SEARCH` / `ENABLE_NOAPI_GOOGLE_SEARCH` | 외부 MCP 검색 provider 강제 등록 |
| `ENABLE_MOCK_PROVIDERS` | `false`면 mock provider 제외 |

API 카탈로그는 런타임마다 GitHub에서 읽지 않고 `data/apiCatalog.json`을 사용합니다. 갱신이 필요하면 아래 스크립트를 수동으로 실행합니다:

```bash
npm run build:api-catalog
```


---

## 테스트 방법

### 1. 자동화 테스트 (유닛 테스트)

```bash
npm test
```

[tests/newsletterMcp.test.ts](tests/newsletterMcp.test.ts)에 vitest 기반 테스트가 있습니다. 아래 시나리오를 커버합니다:

- 사용자 프로파일 및 카테고리 설정 저장/조회
- 채팅 태그 기반 구조화 초안 생성 (섹션 검증)
- 사용자 정의 뉴스레터 템플릿 저장/조회 및 AI 편집 지시문 반영
- 프로파일 기본값 폴백 (관심사·지역·톤·주간 기간)
- 제외 키워드 필터링 및 중복 URL 제거
- RSS 수집 실패 시 graceful 처리
- MCP 프로토콜 버전 유효성 검사
- 툴 메타데이터 정책 준수 검사

### 2. 로컬 서버 직접 호출

서버를 먼저 실행합니다:

```bash
npm run dev
```

curl로 MCP 메시지를 직접 보냅니다:

```bash
# 서버 초기화
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {}
    }
  }'

# 툴 목록 조회
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'

# 뉴스레터 초안 생성
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "generate_newsletter_draft",
      "arguments": {
        "userId": "default",
        "userMessage": "이번 주 애니메이션/일본 뉴스레터 만들어줘",
        "interests": ["애니메이션", "일본"],
        "regions": ["일본"],
        "period": {
          "start": "2026-06-15",
          "end": "2026-06-22"
        }
      }
    }
  }'
```

<details>
<summary>PowerShell용 예시</summary>

```powershell
# 헬스 체크
curl.exe -s http://127.0.0.1:3000/health

# 서버 초기화
node --input-type=module -e "const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'manual-test', version: '0.1.0' } } }; const res = await fetch('http://127.0.0.1:3000/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }); console.log(await res.text());"

# 툴 목록 조회
node --input-type=module -e "const body = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }; const res = await fetch('http://127.0.0.1:3000/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }); console.log(await res.text());"

# 뉴스레터 초안 생성
node --input-type=module -e "const body = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_newsletter_draft', arguments: { userId: 'default', userMessage: '이번 주 애니메이션/일본 뉴스레터 만들어줘', interests: ['애니메이션', '일본'], regions: ['일본'], period: { start: '2026-06-15', end: '2026-06-22' } } } }; const res = await fetch('http://127.0.0.1:3000/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }); console.log(await res.text());"
```

</details>

### 3. MCP Inspector (GUI — 권장)

MCP Inspector는 브라우저 GUI에서 툴을 직접 탐색하고 호출할 수 있는 공식 디버깅 도구입니다.

터미널 두 개를 열어 순서대로 실행합니다:

```bash
# 터미널 1: 서버 실행
npm run dev

# 터미널 2: Inspector 실행
npm run inspect
```

Inspector가 브라우저에서 열리면:

1. 전송 방식으로 **Streamable HTTP** 선택
2. URL에 `http://127.0.0.1:3000/mcp` 입력
3. Connect 클릭
4. Tools 탭에서 원하는 툴 선택 → 인자 입력 → 실행

배포된 서버를 테스트할 경우:

```
https://your-public-domain.example/mcp
```

---

## 응답 형식

모든 툴은 MCP `TextContent` 타입으로 Markdown 텍스트를 반환합니다.

`generate_newsletter_draft` 응답 예시:

```markdown
## 애니메이션/일본 뉴스레터 초안

**Draft ID**: `draft_xxxx`
**Period**: 2026-06-15 ~ 2026-06-22
**Tone**: friendly | **Template**: `default_weekly`
**Generated**: 2026-06-22T...

---

### 오늘 주요 소식

1. **[기사 제목](https://...)** (score: 87)
   기사 요약...
   _출처명 · 2026-06-21_

...

### Sources

- [출처명](https://...)
```

---

## 참고

- RSS 수집은 카테고리 설정에 HTTP(S) `sourceHints`가 있을 때만 동작합니다.
- JSON 스토리지는 `NewsletterStorage` 인터페이스 뒤에 있어 교체 가능합니다.
- 관심사(interests)는 고정 카테고리가 아닌 자유 문자열입니다.
