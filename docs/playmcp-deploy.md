# PlayMCP in KC 배포 안내

이 프로젝트는 PlayMCP in KC의 **Git 소스 빌드** 방식으로 배포할 수 있습니다.

## 권장 배포 방식

저장소를 Git에 업로드했고 루트 경로에 `Dockerfile`이 있다면 **Git 소스 빌드** 방식을 사용하세요.

1. https://playmcp.kakaocloud.io/ 에 접속합니다.
2. 로그인 후 **My MCP**로 이동합니다.
3. **새 MCP 서버 등록**을 클릭합니다.
4. **이미지 등록**을 선택한 뒤 **Git 소스 빌드**를 선택합니다.
5. Git 저장소 주소, 브랜치 또는 기준 버전, Dockerfile 경로를 입력합니다.
6. 서버 상태가 활성화될 때까지 기다립니다.
7. MCP 서버 상세 페이지에서 엔드포인트 URL을 복사합니다.
8. https://playmcp.kakao.com/console 에서 엔드포인트 URL을 등록합니다.

OAuth가 활성화된 서버는 등록 단계의 익명 `tools/list` 요청을 `401`로 차단할 수 있습니다. PlayMCP가 `listTools` 응답을 수동 입력하라고 표시하면 프로젝트 루트에서 다음 명령을 실행하고 출력된 JSON 전체를 붙여 넣습니다.

```bash
npm run --silent print:tools
```

입력 칸에는 `&quot;`가 아니라 일반 JSON 큰따옴표(`"`)를 사용합니다. 출력의 최상위 `{ "tools": [...] }` 구조를 그대로 입력해야 합니다.

## Git 소스 빌드 입력값

PlayMCP 포털에는 아래와 같이 입력하면 됩니다.

| 항목 | 값 |
| --- | --- |
| 서버 이름 | `chat-newsletter-mcp` 또는 DNS 규칙을 만족하는 소문자 이름 |
| 설명 | `채팅 기반 뉴스레터 초안 생성 MCP 서버` |
| Git 저장소 주소 | 이 프로젝트를 업로드한 Git 저장소 HTTPS 주소 |
| Git 기준 버전 | `main`, 브랜치 이름, 또는 태그 |
| Dockerfile 경로 | `Dockerfile` |
| 엔드포인트 경로 | `/mcp` |

서버 이름은 Kubernetes DNS 이름 규칙에 맞게 소문자, 숫자, 하이픈, 점을 사용하세요.

## 런타임 기본값

Docker 이미지는 PlayMCP 배포에 맞춰 아래 기본값을 설정합니다.

| 환경 변수 | 값 |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `3000` |
| `MCP_ENDPOINT_PATH` | `/mcp` |
| `NEWSLETTER_MCP_DATA_DIR` | `/app/data` |
| `PUBLIC_BASE_URL` | `https://migration.playmcp-endpoint.kakaocloud.io` |
| `OAUTH_ENABLED` | `true` |

현재 배포의 실제 MCP 엔드포인트와 OAuth의 Auth0 API Identifier는 모두 `PUBLIC_BASE_URL`과 `MCP_ENDPOINT_PATH`에서 자동 생성됩니다.

## Auth0 사용자 식별 설정

이 배포는 Auth0가 발급한 RS256 access token을 검증하고 `sub` claim을 DB의 `user_id`로 사용합니다. 아래 값들은 공개 OAuth 메타데이터이며 비밀값이 아닙니다.

```env
PUBLIC_BASE_URL=https://migration.playmcp-endpoint.kakaocloud.io
OAUTH_ENABLED=true
OAUTH_ISSUER=https://dev-ekikfczn12akgdal.us.auth0.com/
OAUTH_AUTHORIZATION_SERVERS=https://dev-ekikfczn12akgdal.us.auth0.com/
OAUTH_JWKS_URL=https://dev-ekikfczn12akgdal.us.auth0.com/.well-known/jwks.json
OAUTH_USER_ID_CLAIM=sub
OAUTH_ALLOWED_ALGORITHMS=RS256
OAUTH_SCOPES_SUPPORTED=openid,profile
```

OAuth가 활성화되면 인증되지 않은 MCP 요청은 도구 실행 전에 `401 Unauthorized`로 차단됩니다. 도구 인자로 들어온 `userId`는 신뢰하지 않고 검증된 access token의 `sub`로 덮어쓰기 때문에 여러 사용자가 `default` 프로필을 공유하지 않습니다.

## 선택 환경 변수와 시크릿

시크릿은 채팅에 붙여 넣지 마세요. 비공개 Git PAT, 레지스트리 비밀번호, API 키는 PlayMCP 포털 또는 승인된 안전한 경로에만 입력하세요.

필요에 따라 아래 환경 변수를 설정할 수 있습니다.

| 환경 변수 | 용도 |
| --- | --- |
| `NEWSLETTER_MCP_AUTH_TOKEN` | `Authorization: Bearer <token>` 또는 `X-MCP-Auth: <token>` 인증 활성화 |
| `OAUTH_AUDIENCE` | 필요할 때만 `PUBLIC_BASE_URL`에서 자동 생성된 audience를 덮어쓰는 호환용 override |
| `OAUTH_RESOURCE` | 필요할 때만 자동 생성값을 덮어쓰는 호환용 override |
| `OAUTH_USER_ID_CLAIM` | 사용자별 DB 키로 사용할 JWT claim. 현재 `sub` |
| `BRAVE_SEARCH_API_KEY` | Brave Search 기반 웹 검색 활성화 |
| `TOUR_API_KEY` | TourAPI 커넥터 활성화 |
| `EVENTBRITE_TOKEN` | Eventbrite 커넥터 활성화 |
| `TICKETMASTER_API_KEY` | Ticketmaster 커넥터 활성화 |
| `OPENAQ_API_KEY` | OpenAQ 커넥터 활성화 |

## 로컬 검증

업로드 전에 아래 명령으로 확인하세요.

```bash
npm test
npm run build
docker build -t chat-newsletter-mcp:local .
docker run --rm -p 3000:3000 chat-newsletter-mcp:local
```

서버가 뜨면 헬스 체크를 호출합니다.

```bash
curl http://127.0.0.1:3000/health
```

MCP 엔드포인트는 아래 주소입니다.

```text
http://127.0.0.1:3000/mcp
```
