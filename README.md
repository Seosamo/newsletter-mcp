# Chat Newsletter MCP

채팅 기반 사용자 관심사를 받아 구조화된 뉴스레터 초안 JSON을 생성하는 MCP 서버입니다.

사용자 선호도 관리, 콘텐츠 수집·랭킹·중복 제거, 뉴스레터 템플릿 매핑, LLM 기반 최종 렌더링까지 전 과정을 처리합니다.

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
| `list_user_category_settings` | 사용자 관심 태그 설정 목록 조회 | ✓ |
| `upsert_user_category_setting` | 관심 태그 메타데이터 생성/교체 | |
| `list_newsletter_history` | 최근 생성된 뉴스레터 초안 이력 조회 | ✓ |
| `generate_newsletter_draft` | 채팅 선호도 기반 구조화 초안 생성 | |
| `generate_final_newsletter` | 초안 생성 후 LLM으로 최종 뉴스레터 렌더링 | |

> 채팅 파싱(관심사 추출 등)은 LLM 클라이언트 측에서 처리한 뒤 툴을 호출합니다.

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

### 최종 뉴스레터 LLM 렌더링

`generate_final_newsletter` 툴 사용 시 필요합니다.

| 변수 | 설명 |
|---|---|
| `OPENAI_API_KEY` | OpenAI API 키 (필수) |
| `OPENAI_MODEL` | 사용할 모델 (선택, 기본: `gpt-5.5`) |
| `OPENAI_BASE_URL` | API 베이스 URL (선택) |

> `generate_newsletter_draft`는 OpenAI 키 없이 동작합니다.

---

## 테스트 방법

### 1. 자동화 테스트 (유닛 테스트)

```bash
npm test
```

[tests/newsletterMcp.test.ts](tests/newsletterMcp.test.ts)에 vitest 기반 테스트가 있습니다. 아래 시나리오를 커버합니다:

- 사용자 프로파일 및 카테고리 설정 저장/조회
- 채팅 태그 기반 구조화 초안 생성 (섹션 검증)
- 프로파일 기본값 폴백 (관심사·지역·톤·주간 기간)
- 제외 키워드 필터링 및 중복 URL 제거
- RSS 수집 실패 시 graceful 처리
- LLM 프로바이더를 통한 최종 뉴스레터 렌더링
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

## 최종 뉴스레터 생성 예시

`generate_final_newsletter` 요청 예시:

```json
{
  "userId": "default",
  "userMessage": "이번 주 애니메이션/일본 뉴스레터 만들어줘",
  "interests": ["애니메이션", "일본"],
  "regions": ["일본"],
  "outputFormat": "markdown"
}
```

응답에는 구조화된 `draft`와 LLM이 렌더링한 `newsletter.content`가 모두 포함됩니다.

---

## 참고

- RSS 수집은 카테고리 설정에 HTTP(S) `sourceHints`가 있을 때만 동작합니다.
- JSON 스토리지는 `NewsletterStorage` 인터페이스 뒤에 있어 교체 가능합니다.
- 관심사(interests)는 고정 카테고리가 아닌 자유 문자열입니다.
