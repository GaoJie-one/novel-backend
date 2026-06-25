const crypto = require("crypto");

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getWechatSessionSecret() {
  return process.env.WECHAT_SESSION_SECRET || "";
}

function createWechatSessionToken(openid) {
  const secret = getWechatSessionSecret();

  if (!secret) {
    throw new Error("微信登录环境变量缺失，请配置 WECHAT_SESSION_SECRET。");
  }

  const payload = {
    openid,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function verifyWechatSessionToken(token) {
  const secret = getWechatSessionSecret();

  if (!secret || !token.includes(".")) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedSignatureBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));

    if (!payload.openid || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  createWechatSessionToken,
  verifyWechatSessionToken
};
