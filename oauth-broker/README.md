# Figma REST OAuth Broker

Figma 버전 이력용 OAuth 코드 교환·갱신만 담당하는 Vercel Node Function입니다. Figma 파일, 노드 JSON, 이미지 artifact를 받거나 저장하지 않습니다.

Vercel 프로젝트의 Root Directory를 `oauth-broker`로 지정하고 `.env.example`의 변수를 등록합니다. Figma OAuth App callback은 다음 주소로 고정합니다.

```text
https://<broker-domain>/api/oauth/callback
```

`LOCAL_CALLBACK_ORIGIN`은 `http://127.0.0.1:<port>` 형식만 허용됩니다. `BROKER_TICKET_SECRET`은 32자 이상의 무작위 값이어야 하며, 브라우저 번들에 포함하면 안 됩니다. 로컬 Trace Studio에는 브로커 공개 주소만 `FIGMA_REST_BROKER_URL`로 설정합니다.

```bash
npm ci
npm run typecheck
```
