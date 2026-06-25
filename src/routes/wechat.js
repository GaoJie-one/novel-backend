const express = require("express");
const { getSessionUserId, requireWechatSession } = require("../lib/auth");
const { createSupabaseAdminClient } = require("../lib/supabase");
const { createWechatSessionToken } = require("../lib/wechat-session");

const router = express.Router();

function normalizeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizePositiveNumber(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(parsed), min), max);
}

function countVisibleCharacters(value) {
  return String(value || "").replace(/\s/g, "").length;
}

function formatProject(project, chapters) {
  const normalizedChapters = chapters
    .sort((a, b) => a.chapter_number - b.chapter_number)
    .map((chapter) => ({
      chapterNumber: chapter.chapter_number,
      content: chapter.content || "",
      outline: chapter.outline || "",
      title: chapter.title || `第 ${chapter.chapter_number} 章`
    }));

  return {
    id: project.id,
    title: project.title,
    genre: project.genre || "",
    protagonist: project.main_characters || "",
    setting: project.world_setting || "",
    prompt: project.story_outline || "",
    style: project.tone || "",
    createdAt: project.updated_at || "",
    totalWords: normalizedChapters.reduce((total, chapter) => total + countVisibleCharacters(chapter.content), 0),
    wordsPerChapter: project.words_per_chapter || 0,
    chapterCount: project.chapter_count || normalizedChapters.length,
    chapters: normalizedChapters
  };
}

router.post("/login", async (request, response) => {
  try {
    const appid = process.env.WECHAT_APP_ID;
    const secret = process.env.WECHAT_APP_SECRET;

    if (!appid || !secret) {
      response.status(500).json({ error: "微信登录环境变量缺失，请配置 WECHAT_APP_ID 和 WECHAT_APP_SECRET。" });
      return;
    }

    if (!request.body?.code) {
      response.status(400).json({ error: "缺少微信登录 code。" });
      return;
    }

    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", appid);
    url.searchParams.set("secret", secret);
    url.searchParams.set("js_code", request.body.code);
    url.searchParams.set("grant_type", "authorization_code");

    const codeResponse = await fetch(url);
    const payload = await codeResponse.json();

    if (!codeResponse.ok || payload.errcode || !payload.openid) {
      response.status(401).json({ error: payload.errmsg || "微信登录失败，请稍后重试。" });
      return;
    }

    response.json({
      token: createWechatSessionToken(payload.openid),
      openid: payload.openid
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "微信登录失败，请稍后重试。" });
  }
});

router.get("/projects", async (request, response) => {
  try {
    const session = requireWechatSession(request, response);

    if (!session) {
      return;
    }

    const userId = getSessionUserId(session);
    const supabase = createSupabaseAdminClient();
    const { data: projects, error: projectsError } = await supabase
      .from("projects")
      .select("id,title,genre,tone,chapter_count,words_per_chapter,main_characters,world_setting,story_outline,updated_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });

    if (projectsError) {
      response.status(500).json({ error: projectsError.message || "历史读取失败。" });
      return;
    }

    const projectIds = (projects || []).map((project) => project.id);
    const { data: chapters, error: chaptersError } = projectIds.length
      ? await supabase
          .from("chapters")
          .select("project_id,chapter_number,title,outline,content")
          .in("project_id", projectIds)
          .eq("user_id", userId)
      : { data: [], error: null };

    if (chaptersError) {
      response.status(500).json({ error: chaptersError.message || "章节读取失败。" });
      return;
    }

    const chaptersByProject = new Map();

    for (const chapter of chapters || []) {
      const nextChapters = chaptersByProject.get(chapter.project_id) || [];
      nextChapters.push(chapter);
      chaptersByProject.set(chapter.project_id, nextChapters);
    }

    response.json({
      projects: (projects || []).map((project) => formatProject(project, chaptersByProject.get(project.id) || []))
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "历史读取失败。" });
  }
});

router.post("/projects", async (request, response) => {
  try {
    const session = requireWechatSession(request, response);

    if (!session) {
      return;
    }

    const userId = getSessionUserId(session);
    const sourceChapters = Array.isArray(request.body?.chapters) ? request.body.chapters : [];
    const chapters = sourceChapters.map((chapter, index) => ({
      chapterNumber: normalizePositiveNumber(chapter.chapterNumber, index + 1, 1, 20),
      content: normalizeText(chapter.content, ""),
      outline: normalizeText(chapter.outline, ""),
      title: normalizeText(chapter.title, `第 ${index + 1} 章`)
    }));

    if (!chapters.length) {
      response.status(400).json({ error: "缺少章节内容，无法保存。" });
      return;
    }

    const supabase = createSupabaseAdminClient();
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .insert({
        user_id: userId,
        title: normalizeText(request.body.title, "未命名小说"),
        genre: normalizeText(request.body.genre, "未分类"),
        target_reader: "",
        tone: normalizeText(request.body.style, ""),
        chapter_count: chapters.length,
        words_per_chapter: normalizePositiveNumber(request.body.wordsPerChapter, 2000, 500, 8000),
        main_characters: normalizeText(request.body.protagonist, ""),
        world_setting: normalizeText(request.body.setting, ""),
        story_outline: normalizeText(request.body.prompt, ""),
        status: "completed"
      })
      .select("id,title,genre,tone,chapter_count,words_per_chapter,main_characters,world_setting,story_outline,updated_at")
      .single();

    if (projectError || !project) {
      response.status(500).json({ error: projectError?.message || "作品保存失败。" });
      return;
    }

    const { error: chaptersError } = await supabase.from("chapters").insert(
      chapters.map((chapter) => ({
        project_id: project.id,
        user_id: userId,
        chapter_number: chapter.chapterNumber,
        title: chapter.title,
        outline: chapter.outline,
        content: chapter.content,
        status: "completed"
      }))
    );

    if (chaptersError) {
      await supabase.from("projects").delete().eq("id", project.id).eq("user_id", userId);
      response.status(500).json({ error: chaptersError.message || "章节保存失败。" });
      return;
    }

    response.json({
      project: formatProject(
        project,
        chapters.map((chapter) => ({
          chapter_number: chapter.chapterNumber,
          content: chapter.content,
          outline: chapter.outline,
          title: chapter.title
        }))
      )
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "作品保存失败。" });
  }
});

module.exports = router;
