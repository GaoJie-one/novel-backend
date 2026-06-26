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
