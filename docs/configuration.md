# 환경 변수 및 연동 설정

[README로 돌아가기 (∩ ͡° ͜ʖ ͡° )⊃━☆ﾟ](../README.md)

프로젝트 루트의 `.env`는 서버 시작 시 자동으로 읽습니다 (단, 쉘에 이미 설정한 환경변수가 있으면 그 값을 우선합니다!)
ㅤ

## 프로덕션 배포

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

ㅤ
## OAuth / OIDC Bearer 인증

`OAUTH_ENABLED=true`로 설정하면 OAuth Bearer 토큰으로 사용자를 구분합니다. 
* 사용자별 설정을 다루는 도구는 클라이언트가 전달한 `userId` 대신 검증된 토큰의 claim을 사용합니다
* 사용자 ID에 사용하는 기본 claim은 `sub`입니다

| 변수 | 설명 |
|---|---|
| `OAUTH_ENABLED` | `true`이면 OAuth Bearer 인증 활성화. 값을 지정하지 않으면 `OAUTH_JWKS_URL` 또는 `OAUTH_ISSUER` 설정 여부에 따라 활성화 |
| `OAUTH_ISSUER` | 토큰 검증에 사용할 발급자(issuer). 메타데이터의 기본 인증 서버 주소로도 사용 |
| `OAUTH_AUTHORIZATION_SERVERS` | 보호 리소스 메타데이터에 표시할 인증 서버 URL. 여러 개면 쉼표로 구분 |
| `OAUTH_JWKS_URL` | JWT 액세스 토큰의 서명을 검증할 JWKS 엔드포인트. 생략하면 issuer discovery로 조회 |
| `OAUTH_AUDIENCE` | JWT `aud` 검증에 사용할 값. 기본값은 MCP 엔드포인트 URL |
| `OAUTH_RESOURCE` | MCP 리소스를 식별하는 URI. 기본값은 공개 MCP 엔드포인트 URL |
| `OAUTH_RESOURCE_METADATA_URL` | `WWW-Authenticate` 헤더로 안내할 보호 리소스 메타데이터 URL |
| `OAUTH_USER_ID_CLAIM` | 저장소의 사용자 ID로 사용할 claim 경로. 기본값은 `sub`이며 점으로 구분한 중첩 경로도 지원 |
| `OAUTH_REQUIRED_SCOPES` | 모든 MCP 요청에 필요한 scope. 공백 또는 쉼표로 구분 |
| `OAUTH_SCOPES_SUPPORTED` | 보호 리소스 메타데이터에 표시할 scope. 공백 또는 쉼표로 구분 |
| `OAUTH_ALLOWED_ALGORITHMS` | 허용할 RSA JWT 서명 알고리즘. `RS256`, `RS384`, `RS512` 중 쉼표로 구분해 지정하며 기본값은 `RS256` |

OAuth를 사용하면 클라이언트는 다음 헤더를 보내야 합니다.

```http
Authorization: Bearer <access-token>
```

보호 리소스 메타데이터는 다음 경로에서 제공합니다.

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

Docker 이미지에서는 다음 기본 URL을 기준으로 공개 MCP 엔드포인트와 OAuth resource/audience 기본값을 구성합니다.

```env
PUBLIC_BASE_URL=https://migration.playmcp-endpoint.kakaocloud.io
OAUTH_USER_ID_CLAIM=sub
```

* `MCP_ENDPOINT_PATH=/mcp`일 때 공개 MCP 엔드포인트와 OAuth resource/audience는 `https://migration.playmcp-endpoint.kakaocloud.io/mcp`
* 보호 리소스 메타데이터 URL은 `https://migration.playmcp-endpoint.kakaocloud.io/.well-known/oauth-protected-resource/mcp`로 구성

위 설정에서는 클라이언트가 `userId`를 보내거나 생략하더라도 사용자별 도구는 검증된 JWT의 `sub` 값을 사용자 ID로 사용합니다.

ㅤ
## 데이터 저장

기본 로컬 개발 환경에서는 프로필, 템플릿, 관심사별 설정, 뉴스레터 이력을 `data/` 아래 JSON 파일에 저장합니다. 
`DATABASE_URL`을 설정하면 로컬 PostgreSQL이나 Neon, Supabase, RDS 같은 PostgreSQL 호환 저장소를 사용할 수 있습니다.

| 변수 | 설명 |
|---|---|
| `DATABASE_URL` | PostgreSQL 연결 문자열. 설정하면 JSON 파일 대신 PostgreSQL에 저장 |
| `POSTGRES_URL` | `DATABASE_URL` 대신 사용할 수 있는 변수 |
| `DATABASE_SCHEMA` | PostgreSQL 스키마 이름. 기본값은 `public` |
| `DATABASE_SSL` | TLS가 필요한 관리형 DB에서는 `true` 또는 `require`, TLS를 사용하지 않는 로컬 DB에서는 `false`로 설정 |
| `DATABASE_RUN_MIGRATIONS` | 시작할 때 `CREATE TABLE IF NOT EXISTS` 등을 포함한 마이그레이션 실행. 기본값은 `true` |

PostgreSQL 저장소는 데이터를 다음 관계형 테이블에 나누어 저장합니다.


```
`newsletter_profiles`: 프로필, 일정, 글 형식의 개별 설정값
`newsletter_profile_interests`, `newsletter_profile_regions`, `newsletter_profile_excluded_keywords`: 관심사, 지역, 제외 키워드를 값마다 한 행씩 저장
`newsletter_profile_source_preferences`: 사용자 전체에 적용할 선호 출처
`newsletter_category_settings`, `newsletter_category_source_preferences`: 관심사별 설정과 선호 출처
`newsletter_templates`, `newsletter_template_sections`: 템플릿과 섹션 순서
`newsletter_history`: 생성 요청과 초안 요약
```


* 관심사와 지역을 조회하는 열에는 B-tree 인덱스를 / 카테고리 키워드, 출처 도메인, 이력의 관심사·지역처럼 검색에 사용하는 배열 열에는 GIN 인덱스를 사용합니다.
* `DATABASE_RUN_MIGRATIONS=true`이고 기존 JSONB 기반 스키마가 있으면 기존 테이블의 이름을 임시로 바꾼 뒤 데이터를 관계형 테이블로 옮깁니다. 이때 이전이 성공한 뒤에만 기존 테이블을 삭제합니다. (운영 환경에 처음 적용하기 전에는 DB 스냅샷을 남겨 주세요!)
* 비어 있는 PostgreSQL DB로 처음 실행하면 로컬 `data/templates.json`에서 기본 뉴스레터 템플릿을 가져옵니다.

ㅤ
## 선호 출처 설정

자주 보는 사이트나 신뢰하는 출처를 사용자 전체 또는 특정 관심사에 등록할 수 있습니다. 
* `recommend_api_connectors` 응답의 `Recommended Sources`에서 추천 출처를 확인할 수 있습니다
* 전체에 적용할 출처는 `update_user_preferences`로, 관심사별 출처는 `upsert_user_category_setting`으로 저장합니다

```json
{
  "userId": "default",
  "patch": {
    "sourceLinks": [
      "https://openai.com/blog",
      "https://techcrunch.com/feed/"
    ]
  }
}
```

입력한 링크는 도메인, RSS URL, `site:` 검색 조건으로 정리되어 `sourcePreferences`에 저장됩니다. 이후 초안을 만들 때 등록한 RSS 피드를 직접 수집하고, 검색과 정렬에서도 선호 도메인을 우선 반영합니다!

ㅤ

## 콘텐츠 수집

| 변수 | 설명 |
|---|---|
| `ENABLE_DOMAIN_CONNECTORS` | `false`면 공개 API 기반 도메인 커넥터 비활성화. 배포 기본값은 `false` |
| `DOMAIN_CONNECTOR_MAX_CONNECTORS` | 초안 생성 시 시도할 도메인 커넥터 수 |
| `TOUR_API_KEY` | 한국관광공사 TourAPI 호출 키 |
| `CULTURE_INFO_API_URL` / `CULTURE_INFO_API_KEY` | 문화정보 계열 API 호출 설정 |
| `EVENTBRITE_TOKEN` | Eventbrite API 호출 토큰 |
| `TICKETMASTER_API_KEY` | Ticketmaster Discovery API 호출 키 |
| `KMA_API_URL` / `KMA_API_KEY` | 기상청 계열 API 호출 설정 |
| `OPENAQ_API_KEY` | OpenAQ API 호출 키 |
| `ENABLE_GITHUB_API_CATALOG` | `true`일 때만 GitHub에서 생성한 `data/apiCatalog.json`을 런타임에 사용. 기본값은 `false`이며 내장 API 목록만 사용 |
| `WEB_SEARCH_PROVIDER` | `all`, `tavily`, `external_mcp`, `noapi_google_search`, `none` 중 선택 |
| `TAVILY_API_KEY` | Tavily 웹 검색에 사용할 API 키 |
| `TAVILY_SEARCH_API_URL` | Tavily 호환 검색 엔드포인트 (기본: `https://api.tavily.com/search`) |
| `TAVILY_SEARCH_TOPIC` | Tavily 검색 주제: `general`, `news`, `finance` |
| `TAVILY_SEARCH_DEPTH` | Tavily 검색 깊이: `basic`, `advanced`, `fast`, `ultra-fast` |
| `TAVILY_INCLUDE_RAW_CONTENT` | Tavily 원문 포함 여부와 형식: `false`, `true`, `markdown`, `text` |
| `WEB_SEARCH_PAGE_CHUNK_MAX_CHARS` | Tavily/HTML 본문 chunk 최대 길이 (기본: `1800`) |
| `WEB_SEARCH_PAGE_CHUNK_OVERLAP_CHARS` | Tavily/HTML 본문 chunk 간 겹치는 길이 (기본: `200`) |
| `WEB_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE` | Tavily/HTML 페이지별 근거로 선택할 chunk 수 (기본: `2`) |
| `WEB_SEARCH_MAX_SELECTED_CHUNKS_TOTAL` | Tavily/HTML 전체 근거로 선택할 chunk 수 (기본: `8`) |
| `ENABLE_WEB_SEARCH` | `true`면 Tavily provider를 강제 등록해 설정 누락 경고 확인 |
| `EXTERNAL_MCP_SEARCH_COMMAND` / `NOAPI_GOOGLE_SEARCH_COMMAND` | 외부 검색 MCP 서버 실행 명령 |
| `EXTERNAL_MCP_SEARCH_ARGS` / `NOAPI_GOOGLE_SEARCH_ARGS` | 외부 검색 MCP 서버 실행 인자 |
| `EXTERNAL_MCP_SEARCH_TOOL_NAME` / `NOAPI_GOOGLE_SEARCH_TOOL_NAME` | 호출할 외부 MCP 검색 도구 이름 (공통 설정 기본값: `search`, no-API Google 기본값: `google_search`) |
| `EXTERNAL_MCP_SEARCH_QUERY_PARAM` / `NOAPI_GOOGLE_SEARCH_QUERY_PARAM` | 검색어 파라미터 이름 (기본: `query`) |
| `EXTERNAL_MCP_SEARCH_MAX_RESULTS_PARAM` / `NOAPI_GOOGLE_SEARCH_MAX_RESULTS_PARAM` | 결과 수 파라미터 이름 (공통 설정 기본값: `maxResults`, no-API Google 기본값: `num_results`) |
| `EXTERNAL_MCP_SEARCH_VISIT_PAGES` / `NOAPI_GOOGLE_SEARCH_VISIT_PAGES` | 검색 결과 URL 본문 수집 여부 (no-API Google 기본값: `true`) |
| `EXTERNAL_MCP_SEARCH_MAX_PAGES_TO_VISIT` / `NOAPI_GOOGLE_SEARCH_MAX_PAGES_TO_VISIT` | 본문을 수집할 검색 결과 수 (기본: `3`) |
| `EXTERNAL_MCP_SEARCH_PAGE_CHUNK_MAX_CHARS` / `NOAPI_GOOGLE_SEARCH_PAGE_CHUNK_MAX_CHARS` | 방문 페이지 chunk 최대 길이 (기본: `1800`) |
| `EXTERNAL_MCP_SEARCH_PAGE_CHUNK_OVERLAP_CHARS` / `NOAPI_GOOGLE_SEARCH_PAGE_CHUNK_OVERLAP_CHARS` | 방문 페이지 chunk 간 겹치는 길이 (기본: `200`) |
| `EXTERNAL_MCP_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE` / `NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_PER_PAGE` | 페이지별 근거로 선택할 chunk 수 (기본: `2`) |
| `EXTERNAL_MCP_SEARCH_MAX_SELECTED_CHUNKS_TOTAL` / `NOAPI_GOOGLE_SEARCH_MAX_SELECTED_CHUNKS_TOTAL` | 전체 근거로 선택할 chunk 수 (기본: `8`) |
| `ENABLE_EXTERNAL_MCP_SEARCH` / `ENABLE_NOAPI_GOOGLE_SEARCH` | 외부 MCP 검색 provider 강제 등록 |
| `ENABLE_MOCK_PROVIDERS` | `false`면 mock provider 제외 |

GitHub 기반 외부 API 카탈로그는 기본적으로 비활성화되어 있습니다. 이 상태에서는 네트워크 요청이나 `data/apiCatalog.json` 사용 없이 내장 API 목록만 사용합니다. 

나중에 다시 사용할 때만 명시적으로 활성화하고 카탈로그를 갱신합니다:

```bash
ENABLE_GITHUB_API_CATALOG=true npm run build:api-catalog
```
