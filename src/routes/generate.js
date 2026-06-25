const express = require("express");
const OpenAIModule = require("openai");
const { requireWechatSession } = require("../lib/auth");
const { consumeGenerationQuota } = require("../lib/quota");

const OpenAI = OpenAIModule.default || OpenAIModule;
const router = express.Router();

const fallbackChapterNames = ["命运开端", "暗潮浮现", "风暴逼近", "真相裂隙", "新的征途"];
const maxChapterCompletionAttempts = 5;
const finalChapterRequirement =
  "这是最后一章，必须完成主线冲突、交代主要人物命运，并写出明确的小说结尾。不要留下下一章悬念，不要写成未完待续。";
const middleChapterRequirement =
  "这不是最后一章，需要推进阶段性冲突并在章末留下自然的后续期待，但不能让当前章节显得没有收束。";

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

function createChapterEnding(content) {
  return String(content || "").replace(/\s+/g, " ").trim().slice(-520);
}

function getChapterLengthConfig(wordsPerChapter) {
  const minCharacters = Math.max(350, Math.round(wordsPerChapter * 0.85));
  const targetCharacters = wordsPerChapter;
  const maxCharacters = Math.round(wordsPerChapter * 1.2);

  return {
    maxCharacters,
    maxTokens: Math.min(22000, Math.max(3500, Math.ceil(wordsPerChapter * 3.0))),
    minCharacters,
    targetCharacters
  };
}

function stripCodeFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJsonObject(value) {
  const stripped = stripCodeFence(value);

  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");

    if (start < 0 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function buildFallbackPlan(body) {
  return {
    title: "群像传奇",
    chapters: Array.from({ length: body.chapterCount }, (_, index) => {
      const chapterNumber = index + 1;
      const isFinalChapter = chapterNumber === body.chapterCount;

      return {
        chapterNumber,
        title: `第${chapterNumber}章　${isFinalChapter ? "终局回响" : fallbackChapterNames[index] || "新的转折"}`,
        outline: `主要人物在${body.setting}中推进主线：${body.prompt}。人物设定：${body.protagonist}。${isFinalChapter ? finalChapterRequirement : middleChapterRequirement}`
      };
    })
  };
}

function buildContinuityText(context) {
  if (!context?.previousChapters?.length) {
    return "这是第一章或没有可用前文。请直接进入本章核心场景，不要使用空泛开场。";
  }

  const relevantChapters = context.previousChapters.slice(-3);
  const previousText = relevantChapters
    .map((chapter) => `第 ${chapter.chapterNumber} 章《${chapter.title}》：${chapter.outline}\n结尾状态：${chapter.ending}`)
    .join("\n\n");
  const lastChapter = relevantChapters[relevantChapters.length - 1];

  return `已有前文如下，必须承接人物状态、地点、冲突结果和未解问题，不要重写已发生事件，也不要重复前文的开场镜头或情景描写。

${previousText}

上一章最后状态尤其重要：${lastChapter.ending}`;
}

function normalizePlan(plan, body) {
  const fallback = buildFallbackPlan(body);
  const sourceChapters = Array.isArray(plan?.chapters) ? plan.chapters : [];

  return {
    title: normalizeText(plan?.title, fallback.title),
    chapters: Array.from({ length: body.chapterCount }, (_, index) => {
      const fallbackChapter = fallback.chapters[index];
      const source = sourceChapters[index] || {};

      return {
        chapterNumber: index + 1,
        ending: normalizeText(source.ending, fallbackChapter.ending),
        title: normalizeText(source.title, fallbackChapter.title),
        outline: normalizeText(source.outline, fallbackChapter.outline)
      };
    })
  };
}

function normalizeExistingChapters(value, chapterCount) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const chapterNumber = normalizePositiveNumber(item.chapterNumber, 0, 1, chapterCount);

      if (!chapterNumber) {
        return null;
      }

      return {
        chapterNumber,
        ending: normalizeText(item.ending, ""),
        title: normalizeText(item.title, `第${chapterNumber}章`),
        outline: normalizeText(item.outline, "延续全书主线推进本章剧情。")
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function createOpenAIClient() {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;

  if (!baseURL || !apiKey || !process.env.LLM_MODEL_NAME) {
    throw new Error("LLM 环境变量未配置完整，请检查 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL_NAME。");
  }

  return new OpenAI({ apiKey, baseURL });
}

async function createChatCompletion(client, messages, maxTokens, options = {}) {
  const completion = await client.chat.completions.create({
    model: process.env.LLM_MODEL_NAME,
    messages,
    temperature: options.temperature || 0.82,
    top_p: options.topP || 0.92,
    max_tokens: maxTokens,
    stream: false
  });

  const content = completion.choices[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

async function generatePlan(client, body) {
  const rawPlan = await createChatCompletion(
    client,
    [
      {
        role: "system",
        content:
          "你是一名中文类型小说主编，擅长把简单设定拆成可执行的章节大纲。你必须只返回 JSON，不要输出解释、Markdown 或代码块。"
      },
      {
        role: "user",
        content: `请为下面的小说生成项目标题和章节大纲。

小说类型：${body.genre}
人物设定：${body.protagonist}
世界/故事背景：${body.setting}
情节提示：${body.prompt}
避免事项：${body.avoidances || "无"}
文风语气：${body.style}
章节数量：${body.chapterCount}
每章目标正文长度：约 ${body.wordsPerChapter} 个中文字符

硬性要求：
1. 必须恰好生成 ${body.chapterCount} 章。
2. 这是一部完整小说，不是连续剧开头。无论章节数是 1 章、3 章、5 章还是十几章，都必须在第 ${body.chapterCount} 章结束整个故事。
3. 如果只有 1 章，就在这一章内完成开端、冲突、高潮和结局；如果有多章，就按章节数分配起承转合，最后一章必须是终局。
4. 每章大纲要能支撑约 ${body.wordsPerChapter} 字的完整正文，不能只有一句话。
5. 非最后一章的大纲要包含核心冲突、关键场景、人物行动、情绪推进和章末后续期待。
6. 最后一章的大纲必须包含最终对抗/最终选择、主线谜底或矛盾解决、主要人物命运、情绪落点和明确结尾。
7. 最后一章严禁写“新的征途刚刚开始”“更大的风暴还在后面”“未完待续”这类开放式连载结尾。
8. 每章必须有不同的主要场景、冲突推进和信息增量，不能反复写相同的环境描写、醒来/赶路/望天/回忆式开场。
9. 后一章必须承接前一章的结尾状态，不要让人物关系、地点、伤势、已知线索回到原点。
10. 不要写成说明书，不要写“待扩写”“可继续”等占位内容。

返回 JSON 格式：
{
  "title": "小说标题",
  "chapters": [
    {
      "chapterNumber": 1,
      "title": "第一章 标题",
      "outline": "本章完整大纲"
    }
  ]
}`
      }
    ],
    Math.min(4000, 1200 + body.chapterCount * 700)
  );

  return normalizePlan(parseJsonObject(rawPlan), body);
}

async function generateChapterContent(client, body, planTitle, allChapters, chapter, continuityContext) {
  const planText = allChapters.map((item) => `${item.chapterNumber}. ${item.title}：${item.outline}`).join("\n");
  const isFinalChapter = chapter.chapterNumber === body.chapterCount;
  const chapterEndingRequirement = isFinalChapter ? finalChapterRequirement : middleChapterRequirement;
  const { maxCharacters, maxTokens, minCharacters, targetCharacters } = getChapterLengthConfig(body.wordsPerChapter);
  const continuityText = buildContinuityText(continuityContext);

  let content = stripCodeFence(
    await createChatCompletion(
      client,
      [
        {
          role: "system",
          content:
            "你是一名成熟的中文网文作者。你只输出可直接发布的章节正文，不要输出解释、提纲、总结、Markdown、字数统计或任何括号说明。"
        },
        {
          role: "user",
          content: `请根据章节大纲写出完整章节正文。

小说标题：${planTitle}
小说类型：${body.genre}
文风语气：${body.style}
人物设定：${body.protagonist}
世界/故事背景：${body.setting}
全书主线：${body.prompt}
避免事项：${body.avoidances || "无"}

全书章节安排：
${planText}

前文连续性约束：
${continuityText}

当前章节：第 ${chapter.chapterNumber} 章
章节标题：${chapter.title}
章节大纲：${chapter.outline}
本章结尾要求：${chapterEndingRequirement}

连续性硬性要求：
1. 本章开头必须自然承接上一章结尾状态，不能像新故事一样重新介绍世界观。
2. 不要重复前文已经写过的场景调度、天气氛围、人物心理独白或战斗过程。
3. 每章至少推进一个新决定、新线索、新冲突结果或人物关系变化。
4. 若必须回顾前文，只能用一两句融入行动，不能整段复述。
5. 严格遵守避免事项；如果避免事项与章节大纲冲突，优先满足避免事项并保持剧情合理。

字数硬性要求：
1. 本章正文目标长度是约 ${targetCharacters} 个中文字符。
2. 可接受范围是约 ${minCharacters} 到 ${maxCharacters} 个中文字符，不要明显低于或高于这个范围。
3. 如果快到 ${maxCharacters} 字仍未结束，请立刻收束当前章节，不要继续扩写新事件。
4. 如果剧情写到结尾但低于 ${minCharacters} 字，继续补充场景细节、人物动作、心理活动、对话交锋、环境氛围和冲突推进，直到接近目标字数。
5. 不要只写梗概，不要分点，不要出现“本章目标字数”“以下是正文”“待续扩写”等说明性文字。
6. 正文要有完整场景、连续叙事、人物互动和清晰的章节收束。
7. ${isFinalChapter ? "这是最后一章，必须写出完整小说结尾，让读者明确感到故事已经结束。" : "这不是最后一章，章末可以留下后续期待，但当前章节的核心事件必须有阶段性结果。"}

现在只返回这一章的正文内容。`
        }
      ],
      maxTokens
    )
  );

  for (let attempt = 0; attempt < maxChapterCompletionAttempts && countVisibleCharacters(content) < minCharacters; attempt += 1) {
    const currentCharacters = countVisibleCharacters(content);
    const targetAdditionalCharacters = Math.max(180, targetCharacters - currentCharacters);
    const continuation = stripCodeFence(
      await createChatCompletion(
        client,
        [
          {
            role: "system",
            content:
              "你是一名中文小说作者。你只输出续写正文，不要解释、不要总结、不要重复已写内容、不要使用 Markdown。"
          },
          {
            role: "user",
            content: `上一轮生成的第 ${chapter.chapterNumber} 章正文长度不足。

小说标题：${planTitle}
章节标题：${chapter.title}
章节大纲：${chapter.outline}
前文连续性约束：
${continuityText}
避免事项：${body.avoidances || "无"}
目标正文长度：约 ${targetCharacters} 个中文字符
可接受范围：约 ${minCharacters} 到 ${maxCharacters} 个中文字符
当前正文长度：约 ${currentCharacters} 个中文字符
建议新增：约 ${targetAdditionalCharacters} 个中文字符，补足后自然收束

已生成正文的结尾如下，请从这个结尾自然续写，不要重复：
${content.slice(-1200)}

续写要求：
1. 只输出新增正文。
2. 保持 ${body.style} 的文风。
3. 本次续写约 ${targetAdditionalCharacters} 个中文字符即可，不要明显超过 ${Math.round(targetAdditionalCharacters * 1.25)} 个中文字符。
4. 增加实质剧情、人物对话、动作、心理和场景细节，不要水字数。
5. 续写后让整章总长度落在 ${minCharacters} 到 ${maxCharacters} 字之间，并自然收束。
6. 不要重复前文已有情景描写，续写必须推进当前章节的新动作或新信息。
7. 严格遵守避免事项。
8. ${isFinalChapter ? "续写后必须完成全书结局，解决主线冲突，交代人物命运，不能留下下一章钩子。" : "续写后让本章形成更完整的阶段性收束，并保留自然的下一章期待。"}`
          }
        ],
        Math.min(9000, Math.max(1800, Math.ceil(targetAdditionalCharacters * 2.6)))
      )
    );

    if (!continuation) {
      break;
    }

    content = `${content}\n\n${continuation}`;
  }

  const finalCharacters = countVisibleCharacters(content);

  if (finalCharacters < minCharacters) {
    throw new Error(`第 ${chapter.chapterNumber} 章生成字数偏少：当前约 ${finalCharacters} 字，目标约 ${targetCharacters} 字，可接受范围约 ${minCharacters}-${maxCharacters} 字。请稍后重试。`);
  }

  return content;
}

router.post("/novel", async (request, response) => {
  try {
    const session = requireWechatSession(request, response);

    if (!session) {
      return;
    }

    const rawBody = request.body || {};
    const body = {
      avoidances: normalizeText(rawBody.avoidances, ""),
      existingChapters: normalizeExistingChapters(rawBody.existingChapters, normalizePositiveNumber(rawBody.chapterCount, 1, 1, 20)),
      genre: normalizeText(rawBody.genre, "玄幻"),
      protagonist: normalizeText(rawBody.protagonist, "主要人物：一名踏上改变命运旅程的年轻人"),
      projectTitle: normalizeText(rawBody.projectTitle, ""),
      setting: normalizeText(rawBody.setting, "架空世界"),
      prompt: normalizeText(rawBody.prompt, "主要人物踏上改变命运的旅程"),
      style: normalizeText(rawBody.style, "热血激昂"),
      targetChapterNumber: normalizePositiveNumber(rawBody.targetChapterNumber, 0, 0, 20),
      chapterCount: normalizePositiveNumber(rawBody.chapterCount, 1, 1, 20),
      wordsPerChapter: normalizePositiveNumber(rawBody.wordsPerChapter, 2000, 500, 8000)
    };

    await consumeGenerationQuota(session);

    const client = createOpenAIClient();

    if (body.targetChapterNumber) {
      const sourceChapters = body.existingChapters.length ? body.existingChapters : buildFallbackPlan(body).chapters || [];
      const targetChapter =
        sourceChapters.find((chapter) => chapter.chapterNumber === body.targetChapterNumber) || {
          chapterNumber: body.targetChapterNumber,
          title: `第${body.targetChapterNumber}章`,
          outline: "延续全书主线推进本章剧情。"
        };
      const continuityContext = {
        previousChapters: sourceChapters
          .filter((chapter) => chapter.chapterNumber < targetChapter.chapterNumber)
          .map((chapter) => ({
            chapterNumber: chapter.chapterNumber,
            title: chapter.title,
            outline: chapter.outline,
            ending: chapter.ending || "已有章节，请承接该章大纲所形成的状态，不要重复该章主要场景。"
          }))
      };
      const content = await generateChapterContent(client, body, body.projectTitle || "未命名小说", sourceChapters, targetChapter, continuityContext);

      response.json({
        title: body.projectTitle || "未命名小说",
        chapters: [
          {
            ...targetChapter,
            content
          }
        ]
      });
      return;
    }

    const plan = await generatePlan(client, body);
    const chapters = [];
    const continuityContext = {
      previousChapters: []
    };

    for (const chapter of plan.chapters) {
      const content = await generateChapterContent(client, body, plan.title, plan.chapters, chapter, continuityContext);
      const generatedChapter = {
        ...chapter,
        content
      };

      chapters.push(generatedChapter);
      continuityContext.previousChapters.push({
        chapterNumber: generatedChapter.chapterNumber,
        title: generatedChapter.title,
        outline: generatedChapter.outline,
        ending: createChapterEnding(generatedChapter.content)
      });
    }

    response.json({
      title: plan.title,
      chapters
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "小说生成失败，请稍后重试。" });
  }
});

router.post("/quality", async (request, response) => {
  try {
    const session = requireWechatSession(request, response);

    if (!session) {
      return;
    }

    const body = request.body || {};
    const chapters = Array.isArray(body.chapters) ? body.chapters : [];
    const chapterText = chapters
      .map((chapter, index) => {
        const content = normalizeText(chapter.content, "");
        const excerpt = content.length > 2600 ? `${content.slice(0, 1200)}\n...\n${content.slice(-1200)}` : content;

        return `第 ${chapter.chapterNumber || index + 1} 章：${normalizeText(chapter.title, "未命名章节")}
大纲：${normalizeText(chapter.outline, "无")}
可见字数：${countVisibleCharacters(content)}
正文摘录：
${excerpt}`;
      })
      .join("\n\n---\n\n");

    const client = createOpenAIClient();
    const report = await createChatCompletion(
      client,
      [
        {
          role: "system",
          content:
            "你是一名中文小说责任编辑。请检查小说草稿的连续性、重复、人物一致性、伏笔收束和章节字数。输出简洁中文报告，不要使用 Markdown 表格。"
        },
        {
          role: "user",
          content: `请检查下面这部小说草稿，并给出可执行修改建议。

标题：${normalizeText(body.title, "未命名小说")}
类型：${normalizeText(body.genre, "未设置")}
人物设定：${normalizeText(body.protagonist, "未设置")}
背景：${normalizeText(body.setting, "未设置")}
主线：${normalizeText(body.prompt, "未设置")}
每章目标字数：约 ${body.wordsPerChapter || "未设置"} 字

重点检查：
1. 是否有重复场景、重复环境描写、重复心理独白。
2. 章节之间是否承接自然，地点、伤势、线索、人物关系是否断裂。
3. 人物设定是否跑偏。
4. 伏笔是否有遗忘或结尾是否没有收束。
5. 每章字数是否明显偏离目标。
6. 给出 3-8 条最值得修改的建议。

章节内容：
${chapterText}`
        }
      ],
      2400,
      { temperature: 0.35 }
    );

    response.json({
      report: report || "没有生成检查报告，请稍后重试。"
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "质量检查失败，请稍后重试。" });
  }
});

module.exports = router;
