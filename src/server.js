require("./config");

const cors = require("cors");
const dns = require("node:dns");
const express = require("express");

const generateRoutes = require("./routes/generate");
const projectRoutes = require("./routes/projects");
const wechatRoutes = require("./routes/wechat");

dns.setDefaultResultOrder("ipv4first");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/health/supabase", async (_request, response) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  const result = {
    ok: false,
    configured: {
      url: Boolean(supabaseUrl),
      serviceRoleKey: Boolean(supabaseKey)
    },
    host: "",
    dns: {
      ok: false
    },
    http: {
      ok: false
    }
  };

  let parsedUrl;

  try {
    parsedUrl = new URL(supabaseUrl);
    result.host = parsedUrl.hostname;
  } catch (error) {
    response.status(500).json({
      ...result,
      error: "NEXT_PUBLIC_SUPABASE_URL 不是有效的完整 URL。"
    });
    return;
  }

  try {
    const address = await dns.promises.lookup(parsedUrl.hostname);

    result.dns = {
      ok: true,
      address: address.address,
      family: address.family
    };
  } catch (error) {
    response.status(502).json({
      ...result,
      dns: {
        ok: false,
        error: error instanceof Error ? error.message : "DNS lookup failed"
      },
      error: "云托管容器无法解析 Supabase 域名。"
    });
    return;
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const probeUrl = new URL("/rest/v1/", parsedUrl.origin);
    const probeResponse = await fetch(probeUrl, {
      method: "GET",
      signal: controller.signal,
      headers: supabaseKey
        ? {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`
          }
        : {}
    });

    result.http = {
      ok: true,
      status: probeResponse.status,
      statusText: probeResponse.statusText,
      elapsedMs: Date.now() - startedAt
    };
    result.ok = result.configured.url && result.configured.serviceRoleKey && result.dns.ok && result.http.ok;

    response.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    result.http = {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "fetch failed"
    };

    response.status(502).json({
      ...result,
      error: "云托管容器无法访问 Supabase HTTP 接口。"
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use("/api/wechat", wechatRoutes);
app.use("/api/generate", generateRoutes);
app.use("/api/projects", projectRoutes);

app.use((error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "服务异常，请稍后重试。";

  response.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Novel backend listening on ${port}`);
});
