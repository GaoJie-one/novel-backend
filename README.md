# Novel Backend

Express backend for the Novel Studio WeChat Mini Program. This service is separated from the PC/Web `novelist` project so the mini program can be deployed to WeChat Cloud Hosting without changing the web backend.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

The server defaults to `http://127.0.0.1:3000`.

## WeChat Cloud Hosting

Use the Express.js template, then deploy this folder as the service code.

```text
Build command: npm install
Start command: npm start
Port: 80
```

If Cloud Hosting asks for container configuration, the included `Dockerfile` can be used directly.

If the Cloud Hosting console does not show a Node.js version selector, the runtime is controlled by the container image. This project pins the image in `Dockerfile`:

```dockerfile
FROM node:22-alpine
```

After changing the runtime or dependencies, rebuild and redeploy the Cloud Hosting service so the new image replaces the previous Node.js 20 container.

## Environment Variables

Required:

```env
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL_NAME=
WECHAT_APP_ID=
WECHAT_APP_SECRET=
WECHAT_SESSION_SECRET=
```

Optional:

```env
PORT=3000
LLM_TIMEOUT_MS=120000
LLM_MAX_RETRIES=1
WECHAT_DAILY_GENERATION_LIMIT=5
```

For OpenAI-compatible providers, `LLM_BASE_URL` usually needs to be a complete cloud-accessible HTTPS endpoint that includes `/v1`, for example `https://api.openai.com/v1` or the provider's documented OpenAI-compatible base URL. Do not use `localhost`, `127.0.0.1`, or a private machine URL in Cloud Hosting.

## API

```text
GET  /health
POST /api/wechat/login
POST /api/generate/novel
POST /api/generate/novel-jobs
GET  /api/generate/novel-jobs/:jobId
POST /api/generate/quality
GET  /api/wechat/projects
POST /api/wechat/projects
DELETE /api/projects/:projectId
```

## Database

This backend reuses the existing Supabase `projects`, `chapters`, and `generation_usage` tables. If needed, run `supabase/migrations/0001_generation_usage.sql` in Supabase SQL editor.
