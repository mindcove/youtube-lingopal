// background.js (Service Worker)
// 1) 让点击工具栏图标直接打开侧边栏
// 2) 统一代理对 DeepSeek（或其他OpenAI兼容接口）的请求：
//    - AI_TRANSLATE_BATCH: 批量整篇翻译兜底（YouTube免费机翻覆盖不到目标语言时才会走到这里）
//    - AI_EXPLAIN_WORD: 解释选中的词/概念
//    - AI_OUTLINE: 生成大纲概述
//
// 注意：这里抛出的错误信息会一路传到界面上显示给用户，所以要跟着界面语言走。

importScripts('i18n.js');

const T = (k, v) => YTI18N.t(k, v);

// service worker 随时可能被回收重启，每次醒来都要重新读一遍用户选的语言
async function syncLang() {
  try {
    const { ytlb_settings } = await chrome.storage.local.get({ ytlb_settings: null });
    const pref = (ytlb_settings && ytlb_settings.uiLang) || 'auto';
    YTI18N.setLang(pref !== 'auto' ? pref : YTI18N.detect());
  } catch (e) {
    YTI18N.setLang(YTI18N.detect());
  }
}
syncLang();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ytlb_settings) syncLang();
});

function applyPanelBehavior() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(applyPanelBehavior);
chrome.runtime.onStartup.addListener(applyPanelBehavior);
applyPanelBehavior(); // service worker 每次唤醒都兜底设置一次

// openPanelOnActionClick 为 true 时点击图标由Chrome直接开面板，这个监听器是它失效时的兜底
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// 页面内悬浮按钮点击 -> 打开侧边栏（用户点击带手势，满足 sidePanel.open 的调用要求）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // 纯唤醒用：内容脚本在 mousedown 时先发这个，把休眠的 service worker 叫起来，
  // 等 click 真正触发时它已经活着了，手势上下文才不会在冷启动期间过期。
  if (msg.type === 'YTLB_PING') {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type !== 'YTLB_OPEN_PANEL') return;

  const tabId = sender.tab && sender.tab.id;
  const windowId = sender.tab && sender.tab.windowId;

  // 关键：open() 必须是这里**同步执行的第一件事**。
  // 用户手势只在同步调用栈内有效 —— 前面只要 await 过任何东西（哪怕只是 setOptions），
  // 手势上下文就已经作废，open() 会被 Chrome 直接拒掉。
  let p;
  try {
    p = windowId != null ? chrome.sidePanel.open({ windowId }) : chrome.sidePanel.open({ tabId });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
    return true;
  }

  Promise.resolve(p)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// 记录每次调用的 token 消耗，方便在设置页看到钱花在哪，不用等账单
async function recordUsage(model, usage, feature) {
  if (!usage) return;
  try {
    const cur = await chrome.storage.local.get({ ytlb_usage: null });
    const u = cur.ytlb_usage || { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, byModel: {}, byFeature: {} };
    if (!u.byFeature) u.byFeature = {};
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    // 思维链 token 按输出计费，单独记一份好判断 thinking 是不是真的关掉了
    const reasoning =
      (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
    u.calls += 1;
    u.promptTokens += prompt;
    u.completionTokens += completion;
    u.reasoningTokens += reasoning;
    const m = model || 'unknown';
    if (!u.byModel[m]) u.byModel[m] = { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
    u.byModel[m].calls += 1;
    u.byModel[m].promptTokens += prompt;
    u.byModel[m].completionTokens += completion;
    u.byModel[m].reasoningTokens += reasoning;

    // 按功能再记一份：悬停速查和整篇翻译都走 flash 档，只按模型分的话区分不出是谁花的
    const f = feature || 'other';
    if (!u.byFeature[f]) u.byFeature[f] = { calls: 0, model: m, promptTokens: 0, completionTokens: 0 };
    u.byFeature[f].calls += 1;
    u.byFeature[f].model = m;
    u.byFeature[f].promptTokens += prompt;
    u.byFeature[f].completionTokens += completion;

    await chrome.storage.local.set({ ytlb_usage: u });
  } catch (e) {
    /* 统计失败不能影响正常功能 */
  }
}

async function chatComplete({ apiKey, baseUrl, model, messages, jsonMode, temperature, maxTokens, feature }) {
  if (!apiKey) {
    throw new Error(T('st.noApiKeyLong'));
  }
  const base = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const usedModel = model || 'deepseek-v4-flash';
  const body = {
    model: usedModel,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.3,
    // 关键：DeepSeek V4 两个模型的 thinking 模式都是**默认开启且 effort=high**，
    // 会生成大量隐藏的思维链，而思维链按输出价计费（pro 档输出是输入价的3倍）。
    // 翻译/速查/解释/大纲这几件事都不需要推理，全部显式关掉 —— 这是省钱和提速的大头。
    thinking: { type: 'disabled' },
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  // 兜底封顶，防止模型不听话地长篇大论把钱烧掉
  if (maxTokens) body.max_tokens = maxTokens;

  async function post(payload) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(payload),
      });
    } catch (networkErr) {
      throw new Error(T('st.netFail', { reason: networkErr.message }));
    }
  }

  let res = await post(body);

  // 万一服务商不认 thinking 这个字段（换了兼容接口、或者以后改了名），
  // 去掉它重试一次，保证功能不会整个挂掉——只是这次会贵一点。
  if (res.status === 400) {
    let detail = '';
    try {
      detail = await res.clone().text();
    } catch (e) {}
    if (/thinking/i.test(detail)) {
      const fallback = Object.assign({}, body);
      delete fallback.thinking;
      res = await post(fallback);
    }
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch (e) {}
    throw new Error(T('st.apiFail', { status: res.status, detail: detail.slice(0, 500) }));
  }

  const data = await res.json();
  await recordUsage(usedModel, data.usage, feature);
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return content;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // 模型偶尔会在 JSON 外面包一层 ```json ... ``` ，尝试剥掉再解析一次
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {}
    }
    throw new Error(T('st.badJson', { text: text.slice(0, 300) }));
  }
}

// 同时给中文名和该语言的自称。只写 "français" 的话，模型在满屏中文的提示词里
// 很容易忽略它、直接用中文回答 —— 实测英译法时点词解释就是这么变回中文的。
const LANG_NAMES = { en: '英语（English）', fr: '法语（français）', zh: '简体中文' };

// 输出语言的硬约束。放在提示词最后，模型对末尾指令的遵循度最高。
// keepSourceTerm：用于"解释某个词"这类场景。
// 原来一律写"一个字都不要用其他语言"，模型为了服从这条会把**被解释的词本身**也翻译掉 ——
// 实测点英语词 virtue（目标语言法语）时，返回的是对法语词 vertu 的解释，
// 连举的搭配都是法语的 en vertu de，和那句英语字幕毫无关系。
// 所以必须给原词开一个明确的例外，否则约束越硬错得越离谱。
function mustAnswerIn(targetName, keepSourceTerm) {
  if (keepSourceTerm) {
    return (
      `\n\n【输出语言】说明文字全部使用${targetName}。` +
      `唯一的例外是被解释的原词和你引用的原文搭配 —— 那些保持原样，不要翻译、不要替换。`
    );
  }
  return `\n\n【输出语言】必须全部使用${targetName}作答，一个字都不要用其他语言。`;
}

// 整篇/整批字幕翻译兜底：lines 是 ["...", "...", ...]，返回等长的译文数组
async function aiTranslateBatch({ apiKey, baseUrl, model, lines, targetLang, sourceLang }) {
  const targetName = LANG_NAMES[targetLang] || targetLang;
  const sys =
    `你是专业的字幕翻译。把给定的字幕逐行翻译成${targetName}，严格保持行数和顺序一一对应，` +
    `不要合并、拆分或跳过任何一行，不要添加编号之外的解释。只输出JSON，格式为 ` +
    `{"translations": ["第1行译文", "第2行译文", ...]}，数组长度必须和输入行数完全一致。` +
    mustAnswerIn(targetName);
  const user = lines.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const content = await chatComplete({
    apiKey,
    baseUrl,
    model: model || 'deepseek-v4-flash',
    jsonMode: true,
    temperature: 0.2,
    // 译文长度和原文同量级，按每行留足余量封顶
    maxTokens: Math.min(8000, 120 * lines.length + 200),
    feature: 'transAll',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });
  const parsed = safeParseJson(content);
  const arr = parsed.translations;
  if (!Array.isArray(arr)) throw new Error(T('st.badArray'));
  // 长度对不上时做兜底填充，避免整体失败
  if (arr.length < lines.length) {
    while (arr.length < lines.length) arr.push('');
  }
  return arr.slice(0, lines.length);
}

// 解释选中的词/概念，用目标语言作答
async function aiExplainWord({ apiKey, baseUrl, model, word, sentence, sourceLang, targetLang }) {
  const targetName = LANG_NAMES[targetLang] || targetLang;
  // sourceLang 一直是传进来的，但之前提示词里没用上 —— 模型不知道这个词是哪国语言，
  // 加上"全程只用目标语言"的硬约束，就会把原词换成目标语言里拼写相近的同源词。
  const sourceName = LANG_NAMES[sourceLang] || sourceLang || '原文所用语言';
  // 先分类再作答，不要一上来就套"含义+词性+搭配"的模板。
  //
  // 原来写的是"解释这个词在句中的意思、词性，再补一句常用用法"，
  // 这句话预设了「这是一个普通词汇」，模型顺着这个框架走就出不来了 ——
  // 实测 Move 37 被拆成 move + 37 解释成"第37步棋"，而它其实指
  // AlphaGo 对李世石那一手；Broa 是 Broca 的转写错误，也被按字面硬解。
  // 模型不是不知道，是没被允许往那个方向想。
  //
  // 分类本身几乎不花钱：它改变的是**答案的方向**，不是长度。
  // 系统提示词多约 100 个输入 token（约 $0.0001），输出上限不变。
  const sys =
    `下面给出一段${sourceName}原文，以及其中要解释的词或短语。\n\n` +
    `先判断它属于哪一类，然后**只答那一类**，不要面面俱到：\n` +
    `A 专有名词、事件、作品、人物、圈内典故 → 直接说它指什么、出自哪里，不要拆成单词逐个解释。\n` +
    `  注意：很多这类说法**由普通词组成**，比如「某个数字 + 普通名词」的组合。` +
    `判断时先问一句：这个说法是不是在某个领域被反复引用、有固定所指？是就走 A，别按字面拆。\n` +
    `B 语音转写错误 —— 仅当这个词形在该语言里**根本不存在**、且读音明显指向另一个真实存在的词时才算。\n` +
    `  只是拼写变体、少见词、专有名词、单复数或时态不同，都**不算错误**。拿不准就按 C 处理，不要猜。\n` +
    `C 普通词汇 → 此处含义 + 词性 + 一条常用搭配。是习语或俚语就点明。\n\n` +
    `【要解释的对象】是那个${sourceName}词本身。` +
    `不要换成${targetName}里拼写或词源相近的词，也不要转而讲那个词的用法；` +
    `举搭配时给的必须是${sourceName}里的搭配。\n` +
    `**不要输出 A/B/C 这些标号**，直接给内容 —— 分类是你自己判断用的，不是答案的一部分。\n` +
    `不要复述原文，不要说"这个词的意思是"，不要客套话，不要例句。不超过 60 字，纯文本。` +
    mustAnswerIn(targetName, true);
  const content = await chatComplete({
    apiKey,
    baseUrl,
    model: model || 'deepseek-v4-pro',
    temperature: 0.3,
    maxTokens: 160,
    feature: 'explain',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `${sentence}\n词：${word}` },
    ],
  });
  return String(content || '').trim();
}

// 详细解释：点词解释给的是"够用就走"，这个给的是"想真正弄懂"。
//
// 槽位是照着一个好答案倒推出来的。以 hindsight is 20/20 为例，短解释只会说
// "事后诸葛亮"，而真正有用的是后面几层：20/20 是视力表上的标准视力（字面拆解）、
// 用来给人台阶下（使用场景）、以及**它和中文"马后炮"的褒贬不同**（语用差异）。
// 最后那条是词典查不到、却最影响会不会用错的东西，所以必须单列一个槽位，
// 不然模型基本不会主动讲。
//
// "没有的项直接跳过"是省 token 的关键：专有名词没有字面拆解，普通词没有语用差异，
// 不写这句的话模型会为每个槽位硬凑一段。
async function aiExplainDeep({ apiKey, baseUrl, model, word, sentence, context, sourceLang, targetLang, hasBrief }) {
  const targetName = LANG_NAMES[targetLang] || targetLang;
  const sourceName = LANG_NAMES[sourceLang] || sourceLang || '原文所用语言';
  // 槽位不是拍脑袋定的，是照着二语习得里"知道一个词"的拆解来的（Nation 那套）：
  // 形、义、用。生词卡上「形」有原文、「义」有点词解释和整句译文，唯独「用」是空的 ——
  // 语法框架、搭配、语域和褒贬。而"用"恰恰是词典最不擅长、学习者错得最多的一块，
  // 所以这三个槽位全压在它上面。
  //
  // 例句砍掉了。原来有，但卡片上那句字幕本身就是例句，而且是母语者的真实语料；
  // 模型编的例句是二手仿制品，拿弱的去补强的。单一语境不利于迁移是真的，
  // 但顶上来的应该是"什么场合会说"这种规律，不是又一个个例。
  //
  // 最后一条（和母语说法的差别）价值最高：投入量假说里的 evaluation —— 拿它和别的
  // 说法比、判断哪个合适 —— 对留存的贡献比单纯陈述词义大。不点名说它重要，
  // 模型基本不会主动讲。
  //
  // hasBrief：卡片上已经有点词解释时，词义和字面构成它已经讲过了，这里重复等于
  // 让用户为同样的内容付两次钱。之前是覆盖式写回所以必须自包含，现在两份并存，
  // 可以直接跳过。按 V 直接存的生词没有这份解释，那时才补上前两条。
  // 解释语言和原文语言相同（英语视频、用英文解释）时，"和X里对应说法差在哪"
  // 这一条就退化成"英语和英语比"，纯属废话 —— 直接不要，省掉这段输出。
  const sameLang = !!sourceLang && !!targetLang && sourceLang === targetLang;
  const contrast = sameLang ? '' : `和${targetName}里对应说法差在哪、`;
  const stress = sameLang
    ? ''
    : `最后一条最重要，词典查不到，用错了最容易出问题，尽量不要跳过。\n`;
  const slots = hasBrief
    ? `1. 怎么用 —— 它常出现在什么框架里、前后接什么。给搭配片段，**不要整句例句**\n` +
      `2. 什么场合、什么口吻 —— 书面还是口语、正式程度、谁会这么说\n` +
      (sameLang ? `3. 容易怎么用错\n\n` : `3. ${contrast}容易怎么用错\n\n`) +
      stress +
      `词义和字面构成用户已经看过了，**不要再讲一遍**，直接从用法开始。\n`
    : `1. 什么意思\n` +
      `2. 字面构成 —— 只在字面和实际意思有落差时才拆（典故、比喻、专业缩写、文化梗）\n` +
      `3. 怎么用 —— 常出现在什么框架里、前后接什么。给搭配片段，**不要整句例句**\n` +
      `4. 什么场合、什么口吻 —— 书面还是口语、正式程度、谁会这么说\n` +
      (sameLang ? `5. 容易怎么用错\n\n` : `5. ${contrast}容易怎么用错\n\n`) +
      stress;
  const sys =
    `讲清楚下面这个${sourceName}词或短语**怎么用**。按这个顺序，**没有的项直接跳过，不要硬凑**：\n\n` +
    slots +
    `不要复述原文，不要客套话，不要分点编号以外的排版。总共不超过 180 字。` +
    mustAnswerIn(targetName, true);
  const content = await chatComplete({
    apiKey,
    baseUrl,
    model: model || 'deepseek-v4-pro',
    temperature: 0.3,
    maxTokens: 700,
    feature: 'deepExplain',
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: (context ? `上下文：\n${context}\n\n` : '') + `所在句：${sentence}\n要解释的：${word}`,
      },
    ],
  });
  return String(content || '').trim();
}

// 悬停速查：只要一个最简短的词义，不要用法/例句/词性。
// 刻意用便宜的 flash 档模型 + 极短输出，目的是"快"，代价要低到可以随便划过。
async function aiQuickGloss({ apiKey, baseUrl, model, word, sentence, targetLang }) {
  const targetName = LANG_NAMES[targetLang] || targetLang;
  // 系统提示词每次调用都要算一遍输入费，所以这里刻意压到最短。
  // 也不走 JSON 模式了 —— JSON 包装本身要多花几个输出 token，直接要纯文本更省。
  const sys =
    `说出该词在此句中的意思。只给词义，尽量简短，不要解释、不要例句、不要词性。` +
    mustAnswerIn(targetName);
  const content = await chatComplete({
    apiKey,
    baseUrl,
    model: model || 'deepseek-v4-flash',
    temperature: 0,
    maxTokens: 80, // 不再限制字数，给足余量；输出本来就短，成本可忽略
    feature: 'gloss',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `${sentence}\n词：${word}` },
    ],
  });
  // 模型偶尔还是会带引号或句号，清一下。
  // 不再按字数截断 —— 法语/英语的词义常常一两个词说不完，截断会切出半截话。
  return String(content || '')
    .replace(/^["'「『]|["'」』。.!！]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 无标点字幕的断句辅助（用户看不到这个功能，也没有开关，始终生效）。
// 纯规则判断不了"这句说完没有"（口语里 so I think that 后面可能接着说也可能结束），
// 所以只在**无标点轨道 + 用户按下保存的那一刻**发这一个很小的请求：
// 输入是播放点之前的一小段（约300字符），输出只有最后那句原文。
//
// 故意不传 feature：用量统计的分项列表里不给它单独一行（用户不知道有这个机制，
// 列出来只会引出"这是什么"的疑问）。但它的 token 仍然计入总额和 byModel，
// 所以"累计约 x 元/美元"和输入/输出 token 数是完整的，不存在隐藏开销。
async function aiSegmentSentence({ apiKey, baseUrl, model, text }) {
  const sys =
    `下面是一段没有标点的口语转写。用户刚听完，想记下**最后说完的那一句话**。\n` +
    `请原样输出那一句，一个字都不要改、不要加标点、不要翻译、不要解释。\n` +
    `如果最后一句还没说完，就输出它前面那句完整的。`;
  const content = await chatComplete({
    apiKey,
    baseUrl,
    model: model || 'deepseek-v4-flash',
    temperature: 0,
    maxTokens: 120,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: text },
    ],
  });
  return String(content || '').trim();
}

// 视频内容概括：整篇讲了什么，不分章节、不带时间戳
async function aiOutline({ apiKey, baseUrl, model, transcriptText, targetLang, chapters, description }) {
  const targetName = LANG_NAMES[targetLang] || targetLang;
  // 概括是"读懂+压缩"，不是推理任务，用便宜的 flash 档就够，
  // 而且输入是整篇字幕（这类调用的成本大头在输入侧），降档能直接省下三分之二。
  // 有章节的情况：时间戳和标题全部用 YouTube 自带的，AI **只负责填每段讲了什么**。
  // 这样 AI 没有机会编造时间戳 —— 时间戳编错是这类功能最难发现也最误导人的 bug。
  if (chapters && chapters.length) {
    const sys =
      `你在帮人快速判断一个视频哪几段值得听。下面给出每一节的标题和该节字幕节选，` +
      `请用${targetName}为**每一节**写一句话，说清楚这节实际讲了什么观点或结论，不要只重复标题。\n` +
      `如果某节是赞助商口播、课程/新书/活动宣传、求订阅点赞这类与主题无关的内容，` +
      `该节的 s 直接写"广告"两个字，ad 设为 true。\n` +
      `只输出JSON: {"items":[{"i":序号,"s":"这一节讲了什么","ad":false}]}，序号和输入一一对应。` +
      mustAnswerIn(targetName);
    const user = chapters
      .map((c, i) => `[${i}] ${c.title}\n${(c.excerpt || '').slice(0, 1200)}`)
      .join('\n\n');
    const content = await chatComplete({
      apiKey,
      baseUrl,
      model: model || 'deepseek-v4-flash',
      jsonMode: true,
      temperature: 0.3,
      maxTokens: Math.min(3000, 120 * chapters.length + 200),
      feature: 'outline',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });
    const parsed = safeParseJson(content);
    const byIndex = {};
    (parsed.items || []).forEach((it) => {
      if (typeof it.i === 'number') byIndex[it.i] = it;
    });
    return {
      items: chapters.map((c, i) => ({
        start: c.start,
        title: c.title,
        summary: (byIndex[i] && byIndex[i].s) || '',
        ad: !!(byIndex[i] && byIndex[i].ad),
      })),
      source: 'chapters',
    };
  }

  // 没有章节：只能让 AI 自己分段并给时间戳。
  // 这时时间戳有编错的风险，所以调用方会拿字幕逐条校验并吸附到最近的一句。
  const sys =
    `你在帮人快速判断一个视频哪几段值得听。下面是带时间戳（单位秒）的字幕节选，` +
    `可能是从全片跳着取样的，按整体理解即可。\n` +
    `请用${targetName}把内容分成 5-12 段，每段给出起始秒数和一句话说明这段讲了什么观点或结论。\n` +
    `跳过赞助商口播、课程/新书/活动宣传、求订阅点赞这类与主题无关的内容。\n` +
    `起始秒数必须取自输入中真实出现过的时间戳，不要自己推算。\n` +
    `只输出JSON: {"items":[{"start":秒数,"summary":"这段讲了什么"}]}` +
    mustAnswerIn(targetName);
  const content = await chatComplete({
    apiKey,
    baseUrl,
    model: model || 'deepseek-v4-flash',
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 1600,
    feature: 'outline',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: (description ? '视频简介：' + description.slice(0, 1500) + '\n\n字幕：\n' : '') + transcriptText },
    ],
  });
  const parsed = safeParseJson(content);
  return {
    items: (parsed.items || []).map((it) => ({
      start: Number(it.start) || 0,
      title: '',
      summary: it.summary || '',
      ad: false,
    })),
    source: 'ai',
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'YTLB_AI_TRANSLATE_BATCH') {
    aiTranslateBatch(msg.payload)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'YTLB_AI_SEGMENT') {
    aiSegmentSentence(msg.payload)
      .then((sentence) => sendResponse({ ok: true, sentence }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'YTLB_AI_QUICK_GLOSS') {
    aiQuickGloss(msg.payload)
      .then((gloss) => sendResponse({ ok: true, gloss }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'YTLB_AI_EXPLAIN_DEEP') {
    aiExplainDeep(msg.payload)
      .then((explanation) => sendResponse({ ok: true, explanation }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'YTLB_AI_EXPLAIN_WORD') {
    aiExplainWord(msg.payload)
      .then((explanation) => sendResponse({ ok: true, explanation }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'YTLB_AI_OUTLINE') {
    aiOutline(msg.payload)
      .then((outline) => sendResponse({ ok: true, outline }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});
