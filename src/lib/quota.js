const { getSessionUserId } = require("./auth");
const { createSupabaseAdminClient } = require("./supabase");

function getErrorDetail(error) {
  if (!error) {
    return "";
  }

  if (error instanceof Error) {
    return error.message || "";
  }

  if (typeof error === "object" && "message" in error) {
    return String(error.message || "");
  }

  return String(error || "");
}

function isNetworkError(error) {
  const detail = getErrorDetail(error).toLowerCase();

  return [
    "fetch failed",
    "network",
    "enotfound",
    "econnrefused",
    "econnreset",
    "etimedout",
    "und_err",
    "socket"
  ].some((keyword) => detail.includes(keyword));
}

function createSupabaseQuotaError(error) {
  const detail = getErrorDetail(error);

  if (isNetworkError(error)) {
    return new Error(`Supabase 连接失败，无法记录生成额度。请检查 CloudBase 环境变量 NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY，以及云托管是否可以访问 Supabase 域名。底层错误：${detail || "fetch failed"}`);
  }

  return new Error(detail || "生成额度记录失败，请确认 consume_generation_quota 已创建。");
}

function getDailyLimit() {
  const parsed = Number(process.env.WECHAT_DAILY_GENERATION_LIMIT);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5;
  }

  return Math.round(parsed);
}

async function consumeGenerationQuota(session) {
  const supabase = createSupabaseAdminClient();
  const userId = getSessionUserId(session);
  const dailyLimit = getDailyLimit();
  let result;

  try {
    result = await supabase.rpc("consume_generation_quota", {
      p_daily_limit: dailyLimit,
      p_user_id: userId
    });
  } catch (error) {
    throw createSupabaseQuotaError(error);
  }

  const { data, error } = result;

  if (error) {
    throw createSupabaseQuotaError(error);
  }

  if (data !== true) {
    throw new Error(`今日生成次数已用完，请明天再试。当前每日上限为 ${dailyLimit} 次。`);
  }
}

module.exports = {
  consumeGenerationQuota
};
