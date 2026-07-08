const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase 管理端环境变量缺失，请配置 NEXT_PUBLIC_SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY。");
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    realtime: {
      transport: WebSocket
    }
  });
}

module.exports = {
  createSupabaseAdminClient
};
