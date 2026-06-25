const express = require("express");
const { getSessionUserId, requireWechatSession } = require("../lib/auth");
const { createSupabaseAdminClient } = require("../lib/supabase");

const router = express.Router();

router.delete("/:projectId", async (request, response) => {
  try {
    const session = requireWechatSession(request, response);

    if (!session) {
      return;
    }

    const { projectId } = request.params;

    if (!projectId) {
      response.status(400).json({ error: "缺少项目 ID。" });
      return;
    }

    const userId = getSessionUserId(session);
    const supabase = createSupabaseAdminClient();
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("user_id", userId)
      .maybeSingle();

    if (projectError) {
      response.status(500).json({ error: projectError.message || "项目查询失败。" });
      return;
    }

    if (!project) {
      response.status(404).json({ error: "项目不存在或没有删除权限。" });
      return;
    }

    const { error: chaptersError } = await supabase.from("chapters").delete().eq("project_id", projectId).eq("user_id", userId);

    if (chaptersError) {
      response.status(500).json({ error: chaptersError.message || "章节删除失败。" });
      return;
    }

    const { error: deleteError } = await supabase.from("projects").delete().eq("id", projectId).eq("user_id", userId);

    if (deleteError) {
      response.status(500).json({ error: deleteError.message || "项目删除失败。" });
      return;
    }

    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "项目删除失败。" });
  }
});

module.exports = router;
