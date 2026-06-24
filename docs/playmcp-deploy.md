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

PlayMCP는 배포 후 최종 엔드포인트 URL을 제공하므로 `PUBLIC_BASE_URL`은 선택값입니다. 프로덕션에서 직접 `PUBLIC_BASE_URL`을 설정한다면 HTTPS URL을 사용해야 합니다.

## 선택 환경 변수와 시크릿

시크릿은 채팅에 붙여 넣지 마세요. 비공개 Git PAT, 레지스트리 비밀번호, API 키는 PlayMCP 포털 또는 승인된 안전한 경로에만 입력하세요.

필요에 따라 아래 환경 변수를 설정할 수 있습니다.

| 환경 변수 | 용도 |
| --- | --- |
| `NEWSLETTER_MCP_AUTH_TOKEN` | `Authorization: Bearer <token>` 또는 `X-MCP-Auth: <token>` 인증 활성화 |
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
