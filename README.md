# Figma Raw Data Extractor

Figma URL을 입력하면 Figma MCP 서버의 모든 툴을 호출해 **원본 응답을 가공 없이** 덤프하는 React 앱.

두 개의 데이터 소스를 UI에서 전환할 수 있다.

| 소스 | 인증 | 원격 | 비고 |
|---|---|---|---|
| **REST API** (기본) | Personal Access Token | ✅ | 문서 JSON 원본. 데스크톱 앱 불필요 |
| **MCP** | 없음(로컬) / OAuth(원격) | ❌ | Figma 데스크톱 로컬 서버만 실질 사용 가능 |

### 원격 MCP를 쓸 수 없는 이유

`https://mcp.figma.com/mcp` 는 OAuth Dynamic Client Registration 시 **`client_name`을 화이트리스트로 검사**한다. 승인된 클라이언트(Claude Code, Cursor 등) 외에는 등록 엔드포인트가 무조건 403을 반환한다.

```
POST https://api.figma.com/v1/oauth/mcp/register  →  403 Forbidden
```

> "Only clients listed in the Figma MCP Catalog can connect to the Figma MCP Server."

OAuth 구현체(`server/oauth.mjs`)는 표준 스펙대로 완성되어 있어 Figma가 등록을 개방하거나 사전 등록된 `client_id`가 생기면 그대로 동작한다. 그때까지 원격은 REST API를 쓴다.

## 구조

브라우저는 MCP 서버에 직접 붙을 수 없다(CORS + MCP 세션 핸드셰이크). 그래서 얇은 Node 프록시를 둔다.

```
브라우저 (React/Vite :5173)
   │  POST /api/extract  { url, endpoint }
   ▼
Express 프록시 (:5174)          server/index.mjs
   │  @modelcontextprotocol/sdk — Streamable HTTP (실패 시 SSE 폴백)
   ▼
Figma MCP 서버 (기본 http://127.0.0.1:3845/mcp)
```

- `server/figma-url.mjs` — Figma URL → `fileKey` / `nodeId` / 파일 종류 파싱 (branch URL, `/board/`, `/slides/`, `/make/` 포함)
- `server/mcp.mjs` — MCP 접속 및 파일 종류에 따른 툴 호출 계획 수립
- `server/index.mjs` — HTTP API
- `src/App.tsx` — 입력 UI + 툴별 결과 패널 (text / raw JSON 탭, 복사, 전체 다운로드)

## 사전 준비 (REST API — 기본 경로)

1. Figma → **Settings → Security → Personal access tokens → Generate new token**
2. 스코프는 **File content: Read-only** 면 충분 (변수까지 받으려면 Variables: Read-only 추가, Enterprise 플랜 전용)
3. 앱 실행 후 토큰 입력창에 붙여넣기

토큰은 검증 후 `.figma-token.json`(`chmod 600`, gitignore 대상)에 저장되고 브라우저로 다시 내려가지 않는다. `FIGMA_TOKEN` 환경변수를 쓰면 파일 저장을 건너뛴다.

### 호출하는 REST 엔드포인트

| 엔드포인트 | 조건 | 내용 |
|---|---|---|
| `GET /v1/files/:key/nodes?ids=…&geometry=paths` | node-id 있음 | 해당 서브트리 전체 JSON (벡터 좌표 포함) |
| `GET /v1/files/:key?geometry=paths` | node-id 없음 | 문서 전체 JSON |
| `GET /v1/images/:key?ids=…&format=png&scale=2` | node-id 있음 | 렌더 PNG URL |
| `GET /v1/files/:key/components` | 항상 | 컴포넌트 목록 |
| `GET /v1/files/:key/styles` | 항상 | 스타일 목록 |
| `GET /v1/files/:key/variables/local` | 항상(선택) | 로컬 변수. **Enterprise 전용** — 그 외 플랜은 403이 정상 |

## 사전 준비: 로컬 MCP 서버 켜기

기본 엔드포인트는 Figma 데스크톱 앱의 로컬 MCP 서버다. **인증이 필요 없는 대신 앱이 실행 중이어야 한다.**

1. Figma 데스크톱 앱 실행
2. 메뉴 → Preferences → **Enable local MCP server** 체크
3. `http://127.0.0.1:3845/mcp` 가 열렸는지 확인

UI의 "MCP 엔드포인트 설정"에서 다른 주소로 바꿀 수 있지만, 원격 서버(`https://mcp.figma.com/mcp`)는 OAuth가 필요해 이 프록시로는 아직 붙지 않는다.

## 실행

```bash
npm install
npm run dev     # 프록시(:5174) + Vite(:5173) 동시 기동
```

`http://localhost:5173` 접속 → Figma URL 붙여넣기 → 추출.

## 입력 URL

node-id가 있으면 전 툴이 돌고, 없으면 파일 최상위 페이지 목록만 나온다. Figma에서 레이어 우클릭 → **Copy link to selection** 을 쓰는 게 좋다.

```
https://www.figma.com/design/<fileKey>/<name>?node-id=1-2
```

## 호출하는 툴

| 툴 | 조건 | 내용 |
|---|---|---|
| `get_metadata` | design 파일 | 노드 트리(id/type/name/위치/크기) XML. nodeId 없으면 페이지 목록 |
| `get_design_context` | nodeId 있음 (make는 `0:1` 고정) | 레이아웃·스타일·토큰이 반영된 참조 코드 + 에셋 URL |
| `get_variable_defs` | design + nodeId | 노드에 적용된 Figma 변수 정의 |
| `get_screenshot` | make 아님 + nodeId | 렌더 PNG의 단기 URL |

조건에 안 맞아 건너뛴 툴은 UI 상단 "건너뛴 툴"에 이유와 함께 표시된다 — 조용히 누락되지 않는다.

## 추가 API

| 엔드포인트 | 용도 |
|---|---|
| `GET  /api/health` | 프록시 상태와 기본 엔드포인트 |
| `GET  /api/token/status` | PAT 보유/유효 여부 |
| `POST /api/token` | PAT 검증 후 저장 — `{ token }` |
| `POST /api/token/reset` | PAT 삭제 |
| `GET  /api/auth/status` | 원격 MCP OAuth 인증 상태 |
| `POST /api/auth/reset` | 저장된 OAuth 토큰/클라이언트 등록 정보 삭제 |
| `GET  /oauth/callback` | OAuth 콜백 (Figma가 브라우저를 되돌려보내는 곳) |
| `POST /api/tools` | 연결된 MCP 서버의 툴 목록 + 입력 스키마 원본 |
| `POST /api/call` | 임의 툴 직접 호출 — `{ name, args }` |

`POST /api/extract` 는 `{ url, source: 'rest' | 'mcp', endpoint? }` 를 받는다.

## 환경 변수

- `FIGMA_TOKEN` — Personal Access Token. 설정 시 파일 저장을 건너뛴다
- `FIGMA_MCP_URL` — 기본 MCP 엔드포인트 (기본값 `https://mcp.figma.com/mcp`)
- `PROXY_ORIGIN` — OAuth 콜백 URL의 origin (기본값 `http://127.0.0.1:5174`)
- `PORT` — 프록시 포트 (기본값 `5174`)

## 저장 파일

| 파일 | 내용 | 권한 |
|---|---|---|
| `.figma-token.json` | Personal Access Token | 600, gitignore |
| `.figma-mcp-auth.json` | OAuth 토큰 / 클라이언트 등록 정보 / PKCE verifier | 600, gitignore |
