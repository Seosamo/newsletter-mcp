# 📰 Chat Newsletter MCP

관심 있는 소식을 채팅으로 요청하고, 뉴스레터로 받아볼 수 있는 MCP 서버입니다 ( 'ω' و(و “

ㅤ

## 🙋 어떻게 사용하나요?

MCP를 지원하는 AI 클라이언트에 서버를 연결한 뒤 아래처럼 요청할 수 있습니다.

```text
이번주 애니메이션 소식으로 뉴스레터 만들어줘.
단 스포일러가 들어간 기사는 빼줘.
```

* 클라이언트가 대화에서 관심사와 조건을 추출하고 필요한 도구를 호출하는 방식입니다. 
* 서버는 자료 수집과 초안 생성을 맡고 최종 문장은 클라이언트가 초안과 편집 지시문을 바탕으로 작성합니다. (서버에서 별도로 LLM API를 호출하지는 않습니다!)

ㅤ

## 🔎 동작 과정

1. 사용자의 요청과 저장된 선호도에서 관심사, 지역, 기간 등을 확인
2. 설정된 RSS, 웹 검색, 외부 API에서 관련 자료 수집
3. 중복 URL과 제외 키워드에 해당하는 자료를 필터링, 관심사와 선호 출처 등을 기준으로 순서 배치
4. 선택한 템플릿에 맞춰 Markdown 초안 생성, 출처와 편집 지시문을 함께 반환
5. AI 클라이언트가 이 결과를 바탕으로 사용자에게 뉴스레터 제공

수집에 사용하는 검색 서비스와 API는 서버 설정에 따라 변경할 수 있습니다. 

(현재 Docker 배포 설정은 외부 검색 MCP인 `noapi-google-search-mcp`를 사용합니다!)

ㅤ

## 💡 주요 기능

### 관심사와 출처 저장

관심사는 정해진 카테고리 대신 자유롭게 입력할 수 있습니다. 관심 지역, 제외할 키워드, 글의 톤도 함께 저장합니다.

자주 보는 사이트나 RSS 주소가 있다면 선호 출처로 등록할 수 있습니다. 전체 뉴스레터에 적용하거나 특정 관심사에만 따로 설정할 수 있고, 자료를 수집하고 정렬할 때 해당 설정을 반영합니다.

### 뉴스레터 형식 지정

기본 템플릿을 선택하거나 원하는 섹션과 작성 규칙을 담은 템플릿을 저장할 수 있습니다. 예를 들어 ‘주요 소식 → 행사 일정 → 추천 콘텐츠’ 순서를 저장해 두고 다음 뉴스레터에도 적용하는 식입니다.

### 사용자별 설정과 생성 이력

프로필, 관심사별 설정, 뉴스레터 생성 이력을 저장합니다. OAuth 인증을 사용하면 토큰에서 확인한 사용자 ID를 기준으로 개인 설정과 이력을 구분합니다.

ㅤ

## 🛠 Tool List

| 도구 | 하는 일 |
| --- | --- |
| `get_user_profile` | 저장된 사용자 선호도 조회 |
| `update_user_preferences` | 관심사, 지역, 톤, 선호 출처 등 수정 |
| `list_newsletter_templates` | 뉴스레터 템플릿 목록 조회 |
| `get_newsletter_template` | 선택한 템플릿의 구성 조회 |
| `upsert_newsletter_template` | 뉴스레터 템플릿 추가 또는 수정 |
| `list_user_category_settings` | 관심사별 설정 조회 |
| `upsert_user_category_setting` | 관심사별 키워드와 출처 등 설정 |
| `list_newsletter_history` | 이전에 생성한 뉴스레터 초안 이력 조회 |
| `generate_newsletter_draft` | 자료를 수집하고 뉴스레터 초안 생성 |
| `recommend_api_connectors` | 관심사에 맞는 API 후보와 지원 여부, 출처 추천 |

도구 응답은 모두 Markdown 텍스트로 반환합니다.

ㅤ

## 🚀 로컬 실행

Dockerfile과 같은 Node.js 22 환경을 기준으로 실행할 수 있습니다.

```bash
npm install
npm run dev
```

* 기본 MCP 주소는 `http://127.0.0.1:3000/mcp`입니다. 클라이언트에서 전송 방식을 **Streamable HTTP**로 선택하고 이 주소를 입력하면 됩니다. 서버 연결은 `stdio`나 구버전 HTTP+SSE를 지원하지 않습니다.

* 프로젝트 루트에 `.env`가 있으면 실행할 때 자동으로 읽습니다. 기존 설정이 있다면 호스트, 포트, 인증, 검색 서비스 설정도 함께 적용됩니다. 쉘에 이미 설정된 환경변수는 `.env`보다 우선합니다.

ㅤ

### 테스트

로컬 실행에서는 별도 설정이 없으면 테스트용 mock 데이터가 포함됩니다. 
* 실제 검색 결과만 사용하려면 -> mock을 끄고 검색 서비스를 설정

만약 Tavily 사용하는 경우 `.env`에 다음 값을 설정합니다.

```dotenv
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=your-tavily-api-key
ENABLE_MOCK_PROVIDERS=false
```

RSS는 등록한 RSS 주소나 관심사별 `sourceHints`의 HTTP(S) 주소를 사용합니다. 

외부 검색 MCP를 연결하는 방법은 [웹 검색 설정](docs/web-search.md)에 정리되어 있습니다 :)

ㅤ

### Tool 호출

서버를 실행한 상태에서 다른 터미널에 아래 명령을 입력합니다.

```bash
npm run inspect
```

* Inspector에서 `Streamable HTTP`를 선택하고 `http://127.0.0.1:3000/mcp`로 연결합니다
* `Tools` 탭에서 도구를 선택해 인자를 넣고 실행할 수 있습니다
* 인증을 설정했다면 해당 인증 정보도 함께 전달해야 합니다

빌드와 자동화 테스트는 다음 명령으로 실행합니다.

```bash
npm run build
npm test
```
ㅤ

## 📁 프로젝트 구성

```text
src/
├── mcp/          # 도구 등록, 요청 처리, 인증
├── preferences/  # 사용자 선호도 처리
├── providers/    # RSS, 웹 검색, 외부 API 연동
├── pipeline/     # 콘텐츠 필터링, 정렬, 초안 생성
├── sources/      # 선호 출처 처리
├── catalog/      # API 카탈로그와 추천
├── storage/      # JSON 파일 / PostgreSQL 저장소
├── domain/       # 공통 타입과 기본값
└── config/       # 환경변수와 OAuth URL 설정
data/            # 로컬 데이터와 기본 템플릿
tests/           # 자동화 테스트
docs/            # 배포 및 연동 설정
```

* 별도 DB 설정이 없으면 JSON 파일에 데이터를 저장합니다
* `DATABASE_URL`을 설정하면 PostgreSQL 저장소를 사용합니다
* 로컬 개발 실행의 기본 데이터 경로는 `data/`이며, `NEWSLETTER_MCP_DATA_DIR`로 변경 가능합니다

ㅤ
## 배포 및 상세 설정

PlayMCP in KC 배포에는 루트의 `Dockerfile`을 사용합니다. 배포 환경이나 검색 서비스를 바꿀 때는 아래 문서를 참고하시면 됩니다 ( ◜‿◝ )*.✧

- [PlayMCP 배포 방법](docs/playmcp-deploy.md)
- [환경 변수, 인증, 저장소 설정](docs/configuration.md)
- [웹 검색 및 본문 수집 설정](docs/web-search.md)
