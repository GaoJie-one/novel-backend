const { getSessionUserId } = require("./auth");
const { createSupabaseAdminClient } = require("./supabase");

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

  const { data, error } = await supabase.rpc("consume_generation_quota", {
    p_daily_limit: dailyLimit,
    p_user_id: userId
  });

  if (error) {
    throw new Error(error.message || "生成额度记录失败，请确认 consume_generation_quota 已创建。");
  }

  if (data !== true) {
    throw new Error(`今日生成次数已用完，请明天再试。当前每日上限为 ${dailyLimit} 次。`);
  }
}

module.exports = {
  consumeGenerationQuota
};
