# Notion MCP Trace

Notion 페이지·데이터베이스를 실제 Notion MCP로 읽고, 각 호출의 입력·응답·추출 결과를 단계별로 확인하는 React 기반 로컬 검사 도구입니다.

사용자는 Notion OAuth 또는 개인 토큰으로 워크스페이스를 연결하고, 조회할 Notion URL이나 ID를 입력할 수 있습니다. 애플리케이션은 검색, 대상 조회, 데이터 소스 스키마, 데이터베이스 행, 페이지 본문, 댓글을 순서대로 읽으며 원시 MCP 응답도 함께 보여줍니다.

> 이 프로젝트의 실제 추출 경로는 읽기 전용입니다. MCP 도구 안내 화면에는 지원 범위를 설명하기 위해 쓰기 도구도 표시하지만 호출하지 않습니다.

## 주요 화면

- **추출 검사 (`/`)**: Notion 계정 연결, 대상 입력, MCP 호출 타임라인, 요청·응답·추출 정보 확인
- **MCP 도구 안내 (`/tools`)**: Notion MCP 도구 28개를 읽기·쓰기·관리 범주로 소개하고 연결된 워크스페이스의 실제 가용 상태 표시
- **26행 예제 모드**: Notion 연결 없이 합성 샘플 데이터를 실제 MCP 응답 형태로 재생

## 요구 사항

- Node.js `22.x` 권장 (`20.19.0` 이상 지원)
- npm `10.x` 이상 권장
- 실제 조회 시 접근 가능한 Notion 계정 및 워크스페이스

Node 버전 관리 도구를 사용한다면 저장소의 `.nvmrc`를 기준으로 맞출 수 있습니다.

```bash
nvm use
```

## 로컬 실행

```bash
git clone https://github.com/orca-svg/figma-raw-extractor.git
cd figma-raw-extractor
npm ci
npm run dev
```

실행 후 다음 주소를 엽니다.

- React: http://127.0.0.1:5173
- MCP 도구 안내: http://127.0.0.1:5173/tools
- API 상태: http://127.0.0.1:8787/api/health

`npm run dev`는 Vite 개발 서버와 Express API를 함께 실행합니다.

## Notion 연결

### OAuth 연결

1. 추출 검사 화면에서 확인할 Notion 계정 이메일을 입력합니다.
2. **Notion에서 계정 연결**을 누릅니다.
3. OAuth 승인 화면에서 대상 페이지가 속한 워크스페이스를 선택합니다.
4. 연결 카드에 표시된 이메일과 워크스페이스가 대상 페이지의 소속과 같은지 확인합니다.

같은 이메일로 여러 Notion 워크스페이스에 참여할 수 있습니다. 사용자에게 페이지 권한이 있더라도 MCP가 다른 워크스페이스로 승인되면 `object_not_found`가 발생합니다.

### Personal access token

개발·검증 목적으로 화면의 **개인 토큰으로 연결** 영역을 사용할 수 있습니다. 토큰은 브라우저 저장소나 파일에 기록하지 않고 API 서버 메모리에만 보관합니다.

서버가 다시 시작되면 OAuth 및 개인 토큰 세션이 초기화되므로 다시 연결해야 합니다.

## 환경 변수

기본 포트를 사용할 때는 별도 설정이 필요하지 않습니다. 실행 환경을 변경해야 한다면 `.env.example`의 값을 참고하여 셸 환경 변수로 전달합니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8787` | Express API 포트 |
| `API_ORIGIN` | `http://127.0.0.1:8787` | OAuth 콜백 및 API 기준 주소 |
| `APP_ORIGIN` | 개발 `http://127.0.0.1:5173` | OAuth 완료 후 돌아올 React 주소 |

예시:

```bash
PORT=8787 \
API_ORIGIN=http://127.0.0.1:8787 \
APP_ORIGIN=http://127.0.0.1:5173 \
npm run dev
```

`.env`, OAuth 토큰, Notion 개인 토큰은 저장소에 커밋하지 마세요.

## 구현된 MCP 읽기 흐름

1. `tools/list`: 현재 연결에서 사용할 수 있는 MCP 도구 확인
2. `fetch({ id: "self" })`: 사용자, 워크스페이스, 플랜별 도구 가용 상태 확인
3. `search`: 워크스페이스 의미 검색
4. `fetch(target)`: 대상 페이지·데이터베이스 본문과 데이터 소스·뷰 정보 조회
5. `fetch(collection://...)`: 데이터 소스 속성 스키마 조회
6. `query_data_sources`: 활성·보관 행 및 페이지네이션 조회
7. `query_database_view`: 데이터베이스 뷰 호환 조회
8. `query_data_sources` SQL 모드: 전체 속성 조회
9. 행별 `fetch`: 각 행의 페이지 본문과 생략된 블록 조회
10. `get_comments`: 페이지·블록 댓글과 해결된 토론 조회

Notion MCP가 첨부파일 본문 다운로드를 제공하지 않는 경우에는 `fetch` 응답에 포함된 첨부 URL과 메타데이터까지만 기록합니다.

## 프로젝트 구조

```text
src/                  React UI
  components/         연결, 대상 입력, 타임라인, 응답 검사, 도구 안내
server/               Express API, OAuth, MCP 클라이언트, 추출 파이프라인
tests/                MCP 응답 파서와 추출 흐름 테스트
notion_sample_rows_26.csv
                      연결 없이 사용하는 예제 데이터
```

## 사용 가능한 명령

```bash
npm run dev          # React와 API 개발 서버 동시 실행
npm run dev:web      # React만 실행
npm run dev:server   # API만 실행
npm test             # Vitest 테스트 1회 실행
npm run test:watch   # 테스트 감시 모드
npm run typecheck    # TypeScript 검사
npm run build        # 프로덕션 번들 생성
npm start            # 빌드된 화면과 API를 8787 포트에서 실행
```

프로덕션 모드 확인:

```bash
npm run build
npm start
```

이 경우 React 정적 파일과 API가 모두 http://127.0.0.1:8787 에서 제공됩니다.

## 변경 전 확인

```bash
npm run typecheck
npm test
npm run build
```

## 문제 해결

### `object_not_found` 또는 404

- 연결 카드의 워크스페이스가 대상 페이지의 워크스페이스와 같은지 확인합니다.
- 브라우저에서 연결된 계정으로 대상 링크가 실제로 열리는지 확인합니다.
- 링크드 데이터베이스라면 표시된 뷰뿐 아니라 원본 데이터베이스에도 접근 권한이 있어야 합니다.
- **연결 해제** 후 올바른 워크스페이스를 선택하여 OAuth를 다시 승인합니다.

### 5173 또는 8787 포트 충돌

기존 개발 서버를 종료하거나 환경 변수와 `vite.config.ts`의 개발 포트를 함께 변경합니다.

### MCP 도구가 제한적으로 표시됨

Notion 플랜이나 워크스페이스 설정에 따라 `query_data_sources`, 회의 노트 등의 도구가 제한되거나 업그레이드를 요구할 수 있습니다. 도구 안내 화면의 상태는 `fetch({ id: "self" })`가 반환한 현재 연결 기준입니다.

## 보안 원칙

- OAuth/PAT 토큰은 서버 메모리에만 저장합니다.
- `.env`와 인증 정보는 Git에서 제외합니다.
- 실제 추출 실행에서는 쓰기 도구를 호출하지 않습니다.
- 원시 응답에는 페이지 내용이나 사용자 정보가 포함될 수 있으므로 외부 공유 전에 확인하세요.
