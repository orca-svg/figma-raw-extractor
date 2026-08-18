# MCP Trace Studio

Notion과 Figma MCP가 실제로 호출한 Tool의 입력, 원시 응답, 소요 시간, 실패와 생략을 단계별로 확인하는 React 기반 로컬 검사 도구입니다.

이 프로젝트는 읽기 전용입니다. 도구 안내 화면에는 서버가 제공하는 쓰기 Tool도 표시하지만 추출 경로에서는 호출하지 않습니다.

## 화면

- `/notion`: Notion 계정 연결, 페이지·데이터베이스 추출 타임라인
- `/notion/tools`: Notion MCP Tool 지도와 워크스페이스별 가용 상태
- `/figma`: Figma Desktop/Remote 연결, Design·FigJam 노드 추출 타임라인
- `/figma/tools`: Desktop/Remote 및 파일 유형별 Figma MCP Tool 지도
- `/`와 기존 `/tools`는 각각 `/notion`, `/notion/tools`로 이동합니다.

## 요구 사항

- Node.js `22.x` 권장 (`20.19.0` 이상 지원)
- npm `10.x` 이상 권장
- Notion 실제 추출: 접근 가능한 Notion 계정 또는 개인 토큰
- Figma Desktop 추출: 최신 Figma 데스크톱 앱과 Dev Mode MCP 서버

```bash
nvm use
npm ci
npm run dev
```

실행 주소:

- Web: http://127.0.0.1:5173/notion
- API: http://127.0.0.1:8787/api/health

## Notion 연결

Notion 모드는 OAuth 또는 개인 토큰을 지원합니다. 토큰은 브라우저 저장소나 파일에 기록하지 않고 API 서버 세션 메모리에만 둡니다.

구현된 읽기 흐름:

1. `tools/list`
2. `fetch({ id: "self" })`
3. `search`
4. `fetch(target)`
5. 데이터 소스와 뷰 조회
6. SQL 방식 행 조회
7. 행별 본문 조회
8. 댓글과 토론 조회

연결이 없어도 26행 CSV fixture로 전체 흐름을 재생할 수 있습니다.

## Figma 연결

### Desktop MCP

1. Figma 데스크톱 앱에서 Design 또는 FigJam 파일을 엽니다.
2. Dev Mode로 전환합니다.
3. Inspect 패널의 MCP 서버를 켭니다.
4. `/figma`에서 `Desktop MCP 다시 확인`을 누릅니다.

서버는 `http://127.0.0.1:3845/mcp`에 직접 연결합니다. 노드 링크와 Figma 앱의 현재 선택을 모두 지원합니다.

### Remote MCP beta

Remote는 `https://mcp.figma.com/mcp`의 OAuth 흐름을 사용합니다. Figma의 승인 클라이언트 정책에 따라 이 독립 클라이언트의 인증이 제한될 수 있으며, 실패해도 Desktop 모드는 계속 사용할 수 있습니다.

### 파일 유형과 Tool 흐름

노드 링크의 `/design/`·`/board/` 경로로 유형을 감지합니다. Desktop 현재 선택은 Design을 먼저 확인하고 파일 유형 오류일 때 FigJam으로 전환합니다.

Design 기본 흐름:

1. `tools/list`
2. `get_design_context`
3. 큰 응답일 때 `get_metadata`
4. `get_screenshot`
5. `get_variable_defs`
6. `get_code_connect_map`
7. `get_motion_context`
8. 선택 옵션에 따라 `get_libraries`, `download_assets`

FigJam 기본 흐름:

1. `tools/list`
2. `get_figjam`
3. `get_screenshot`
4. 선택 옵션에 따라 `download_assets`

Figma Design 예제 모드는 연결 없이 합성 MCP 응답과 screenshot artifact를 재생합니다. FigJam 예제는 제공하지 않습니다.

## 원시 응답과 번들

인스펙터는 원시 응답을 기본 탭으로 엽니다. 이미지와 blob은 base64를 UI에 출력하지 않고 binary artifact로 분리합니다.

Figma 실행 결과는 전체 JSON으로 복사하거나 ZIP으로 받을 수 있습니다.

```text
manifest.json
trace.ndjson
responses/<order>-<tool>.json
artifacts/screenshots/*
artifacts/assets/*
README.md
```

실행 기록은 서버 메모리에 30분 동안, 세션당 최근 3개, 총 artifact 100MB까지 보관합니다. 영구 저장하거나 서버 로그에 원문을 남기지 않습니다.

## API

Notion:

- `GET /api/notion/status`
- `POST /api/notion/auth/start`
- `POST /api/notion/auth/pat`
- `POST /api/notion/auth/logout`
- `POST /api/notion/extract/stream`

기존 `/api/status`, `/api/auth/*`, `/api/extract/stream`은 Notion 별칭으로 유지됩니다.

Figma:

- `GET /api/figma/status?transport=desktop|remote`
- `POST /api/figma/auth/start`
- `GET /api/figma/auth/callback`
- `POST /api/figma/auth/logout`
- `POST /api/figma/extract/stream`
- `GET /api/figma/runs/:runId`
- `GET /api/figma/runs/:runId/bundle.zip`

추출 스트림은 `application/x-ndjson`이며 각 이벤트에 provider, runId, origin, Tool, 입력, 원시 응답, 상태, 소요 시간, 응답 byte와 artifact 참조가 포함됩니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8787` | Express API 포트 |
| `API_ORIGIN` | `http://127.0.0.1:8787` | OAuth callback과 API 기준 주소 |
| `APP_ORIGIN` | 개발 `http://127.0.0.1:5173` | OAuth 뒤 돌아올 Web 주소 |

## 검증

```bash
npm run typecheck
npm test
npm run build
```

## 보안 원칙

- Notion/Figma 인증 정보는 서버 세션 메모리에만 저장합니다.
- 실제 추출은 읽기 Tool로 제한합니다.
- `use_figma`, 업로드, 파일 생성, Code Connect 쓰기 Tool은 호출하지 않습니다.
- 원시 응답에는 비공개 문서와 디자인 정보가 포함될 수 있으므로 ZIP을 외부에 공유하기 전에 확인하세요.
