const crypto = require("crypto");
const { verifyWechatSessionToken } = require("./wechat-session");

function createDeterministicUuid(value) {
  const hash = crypto.createHash("sha256").update(`wechat:${value}`).digest();

  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function getSessionFromRequest(request) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const wechatSession = token ? verifyWechatSessionToken(token) : null;

  if (!wechatSession) {
    return null;
  }

  return {
    id: wechatSession.openid,
    kind: "wechat"
  };
}

function getSessionUserId(session) {
  return createDeterministicUuid(session.id);
}

function requireWechatSession(request, response) {
  const session = getSessionFromRequest(request);

  if (!session) {
    response.status(401).json({ error: "登录状态已失效，请重新登录。" });
    return null;
  }

  return session;
}

module.exports = {
  getSessionUserId,
  requireWechatSession
};
