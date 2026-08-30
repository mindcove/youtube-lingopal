// content.js
// 运行在 YouTube 视频页（隔离世界，但和 utils.js 共享同一个 window，所以能直接用全局 YTLB）。
//
// 职责：
// 1) 拿到字幕轨道 -> 解析原文字幕 -> 尝试用 YouTube 自己的机器翻译(tlang参数)免费拿目标语言字幕
// 2) 免费机翻拿不到 / 用户开了"翻译质量优先"时，退回调用 DeepSeek（走 background.js 代理）
// 3) 跟踪播放进度，维护"当前句"；在视频画面上叠加双语字幕浮层，支持点词弹窗解释、重放上一句快捷键
// 4) 响应 sidepanel 的请求；解释/翻译动作触发时按设置自动保存到笔记/生词本

(function () {
  if (window.__YTLB_CONTENT_LOADED__) return;
  window.__YTLB_CONTENT_LOADED__ = true;

  const T = (k, v) => YTI18N.t(k, v);

  // ---------- 扩展重载后的自我了断 ----------
  // 在 chrome://extensions 点了刷新之后，页面上残留的是**上一个版本**的内容脚本。
  // 它和扩展的连接已经断了，任何 chrome.runtime 调用都会抛
  // "Extension context invalidated"。定时器还在跑的话会一直刷屏报错，
  // 而各处的 try/catch 又把错误吞掉，表现就是"功能静默失效"。
  // 所以：检测到失效就停掉所有定时器，并在页面上明确提示要刷新。
  let contextDead = false;
  const timers = [];
  function track(id) {
    timers.push(id);
    return id;
  }
  function isContextAlive() {
    if (contextDead) return false;
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  function markContextDead() {
    if (contextDead) return;
    contextDead = true;
    timers.forEach(clearInterval);
    const btn = document.getElementById('ytlb-launcher');
    if (btn) {
      btn.textContent = T('ov.reloadPage');
      btn.style.opacity = '1';
    }
    console.warn('[Lingopal] ' + T('ov.reloadPage'));
  }
  // 统一出口：所有发往后台的消息都走这里，失效时立即暴露而不是静默失败。
  //
  // 两处必须小心（都踩过）：
  // 1) 这里面只能用 chrome.runtime.sendMessage 原始调用。写成 send() 就是无限递归。
  // 2) "Receiving end does not exist" **是正常情况** —— 侧边栏没打开时就没有接收方，
  //    而字幕每换一句都会广播一次。把它当成"扩展失效"的话，看几秒视频整个插件就停摆了。
  //    只有 "Extension context invalidated" 才是真的被孤立。
  async function send(payload) {
    if (!isContextAlive()) {
      markContextDead();
      return { ok: false, error: T('ov.reloadPage'), dead: true };
    }
    try {
      const res = await chrome.runtime.sendMessage(payload);
      return res === undefined ? { ok: false, error: T('st.noResponse') } : res;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/context invalidated/i.test(msg)) {
        markContextDead();
        return { ok: false, error: T('ov.reloadPage'), dead: true };
      }
      if (/Receiving end does not exist|message port closed/i.test(msg)) {
        return { ok: false, error: T('st.noResponse'), noReceiver: true };
      }
      return { ok: false, error: msg };
    }
  }

  // 浮层上的文字也要跟着界面语言走。设置一变就重画一次浮层和入口按钮，
  // 否则要等下一句字幕出现才更新。
  function syncLang(settings) {
    const pref = (settings && settings.uiLang) || 'auto';
    YTI18N.setLang(pref !== 'auto' ? pref : YTI18N.detect());
  }

  const TLANG_CANDIDATES = { en: ['en'], fr: ['fr'], zh: ['zh-Hans', 'zh-CN', 'zh'] };

  const state = {
    videoId: null,
    videoTitle: null,
    sourceLang: null,
    targetLang: null, // 本视频实际生效的目标语言
    transcript: [], // [{start, dur, original, target}]
    sentences: [], // 由字幕条合并出的完整句子，笔记以它为单位
    chapters: [], // 视频作者自己写的章节（免费，带时间戳）
    tracks: [], // 这个视频有哪些字幕轨道，供用户手动指定原文语言
    forcedSourceLang: null, // 用户指定的原文语言（自动识别不可靠时的出口）
    tracks: [], // 这个视频有哪些字幕轨道，供用户手动指定原文语言
    forcedSourceLang: null, // 用户指定的原文语言（自动识别不可靠时的出口）
    translationSource: 'none', // 'youtube' | 'deepseek' | 'none'
    failReason: null, // null | 'no-captions' | 'no-access' | 'empty-transcript'
    currentIndex: -1,
    lastAutoSavedIndex: -1,
    loading: false,
    settings: null,
    outlineCache: null,
  };

  // ---------- 基础：拿字幕轨道 ----------
  function getVideoIdFromUrl() {
    try {
      return new URLSearchParams(location.search).get('v');
    } catch (e) {
      return null;
    }
  }

  // 向 MAIN world 的 inject.js 要"字幕请求模板"和轨道信息。
  // 不能直接用 captionTracks[].baseUrl —— 那个缺 pot 参数，请求会返回 200 但 body 为空。
  let capReqSeq = 0;
  function requestCaptionAccess(videoId) {
    return new Promise((resolve) => {
      const reqId = 'r' + ++capReqSeq + '_' + Date.now();
      let done = false;
      function handler(e) {
        if (e.source !== window || !e.data) return;
        if (e.origin && e.origin !== location.origin) return;
        if (e.data.type !== 'YTLB_CAP_RES' || e.data.reqId !== reqId) return;
        if (done) return;
        done = true;
        window.removeEventListener('message', handler);
        resolve(e.data.payload);
      }
      window.addEventListener('message', handler);
      window.postMessage({ type: 'YTLB_CAP_REQ', reqId, videoId }, location.origin);
      // inject.js 内部最长会等约 10 秒（被动等待 + 主动触发），这里留够余量
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener('message', handler);
        resolve(null);
      }, 15000);
    });
  }

  // 判断视频原语言。注意不能用 defaultCaptionTrackIndex —— 那反映的是浏览器 UI 语言偏好，
  // 不是视频实际语言（实测英语视频在法语环境下会指向法语轨道）。
  function detectSourceLang(access) {
    if (!access) return null;
    if (access.defaultAudioLanguage) return YTLB.normalizeLang(access.defaultAudioLanguage);
    const tracks = access.tracks || [];
    // ASR（自动语音识别）只会转录说话人实际使用的语言，不会翻译，所以它的语言就是源语言
    const asr = tracks.find((t) => t.kind === 'asr');
    if (asr) return YTLB.normalizeLang(asr.languageCode);
    if (tracks.length === 1) return YTLB.normalizeLang(tracks[0].languageCode);
    return null;
  }

  // 用户为某个视频指定的原文语言，按 videoId 存 —— 同一个视频下次打开还是这条轨道。
  // 不做成全局设置：这是"这个视频的音频是什么语言"，跟别的视频无关。
  const FORCED_STORE = 'ytlb_forced_source';
  const FORCED_KEEP = 60;

  function getForcedSource(videoId) {
    if (!videoId) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [FORCED_STORE]: {} }, (res) => {
          const hit = (res[FORCED_STORE] || {})[videoId];
          resolve((hit && hit.lang) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function setForcedSource(videoId, lang) {
    if (!videoId) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [FORCED_STORE]: {} }, (res) => {
          const store = res[FORCED_STORE] || {};
          if (lang) store[videoId] = { lang, at: Date.now() };
          else delete store[videoId];
          const keys = Object.keys(store);
          if (keys.length > FORCED_KEEP) {
            keys
              .sort((a, b) => (store[a].at || 0) - (store[b].at || 0))
              .slice(0, keys.length - FORCED_KEEP)
              .forEach((k) => delete store[k]);
          }
          chrome.storage.local.set({ [FORCED_STORE]: store }, resolve);
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // 选用来当"原文"的那条轨道：优先源语言的人工字幕，其次源语言的自动字幕
  function pickSourceTrack(tracks, sourceLang) {
    if (!tracks || !tracks.length) return null;
    if (sourceLang) {
      const inLang = tracks.filter((t) => YTLB.normalizeLang(t.languageCode) === sourceLang);
      const manual = inLang.find((t) => t.kind !== 'asr');
      if (manual) return manual;
      if (inLang.length) return inLang[0];
    }
    return tracks.find((t) => t.kind !== 'asr') || tracks[0];
  }

  // 用捕获到的模板拼出真正能用的请求 URL。
  // 已验证 signature 覆盖的 sparams 里不含 lang/tlang/kind/fmt，所以这几个参数可以自由替换。
  function buildTimedTextUrl(template, langCode, kind, tlang) {
    let url = template + '&lang=' + encodeURIComponent(langCode);
    if (kind === 'asr') url += '&kind=asr';
    if (tlang) url += '&tlang=' + encodeURIComponent(tlang);
    return url;
  }

  async function fetchJson3(url) {
    let res;
    try {
      res = await fetch(url, { credentials: 'include' });
    } catch (e) {
      return null;
    }
    if (!res.ok) return null;
    const text = await res.text();
    // 鉴权不通过时 YouTube 返回的是 200 + 空 body，不是错误码，必须单独判空
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // json3 的 ASR 轨道会把一条字幕拆成"首条 + 若干续条"，续条带 aAppend:1。
  // 续条是**接着上一条往下写**，不是新的一句 —— 而且它可以从词的中间接上：
  // 实测存下来的笔记里出现过 "in telligence"（intelligence 被拆成两条）、
  // 开头是 "rd about"（hard 的后半截）。
  //
  // 把续条当成独立字幕条会有两个后果：拼流时中间被塞进一个空格，切句时
  // 又把词中间当成安全的切点。所以这里先按 aAppend 合回去，后面拿到的
  // 每一条都是完整的词序列。
  //
  // 合并时**不加任何分隔符**：该有的空格 YouTube 已经写在 utf8 里了，
  // 自己补一个就正是造成 "in telligence" 的那一步。
  function parseEvents(data) {
    const entries = [];
    for (const ev of (data && data.events) || []) {
      if (!ev.segs) continue;
      // 先不 trim：续条的首尾空格是有意义的，trim 掉之后就分不清
      // "接着写同一个词"和"下一个词"了
      const raw = ev.segs
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\n/g, ' ');
      if (!raw) continue;
      const endMs = (ev.tStartMs || 0) + (ev.dDurationMs || 0);
      const prev = entries[entries.length - 1];
      if (ev.aAppend && prev) {
        prev.text += raw;
        // 续条把这一条的时长往后拉，不然整句的结束时间会停在首条上
        prev.dur = Math.max(prev.dur, endMs / 1000 - prev.start);
        continue;
      }
      entries.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text: raw });
    }
    // 合并完再收拾空白，中间的多余空格这时才能安全压掉
    const out = [];
    for (const e of entries) {
      e.text = e.text.replace(/\s+/g, ' ').trim();
      if (e.text) out.push(e);
    }
    return out;
  }

  // 走 YouTube 自带的免费机器翻译（tlang 参数），不花钱
  async function tryFetchTlang(template, track, targetLang) {
    const candidates = TLANG_CANDIDATES[targetLang] || [targetLang];
    for (const code of candidates) {
      const url = buildTimedTextUrl(template, track.languageCode, track.kind, code);
      const data = await fetchJson3(url);
      const parsed = data ? parseEvents(data) : [];
      if (parsed.length > 0) return parsed;
    }
    return [];
  }

  // 按时间轴对齐原文和译文。
  // 不能按下标一一对应：实测同一条 ASR 轨道，原文 226 句、机翻 221 句，
  // 按下标对齐会从第一处缺失开始整体错位。这里改成按时间重叠度匹配。
  function alignByTime(originals, targets) {
    const out = new Array(originals.length).fill(null);
    if (!targets.length) return out;
    let j = 0;
    for (let i = 0; i < originals.length; i++) {
      const o = originals[i];
      const oEnd = o.start + (o.dur || 0);
      while (j < targets.length && targets[j].start + (targets[j].dur || 0) <= o.start) j++;
      let best = null;
      let bestOverlap = 0;
      for (let k = j; k < targets.length; k++) {
        const t = targets[k];
        if (t.start >= oEnd) break;
        const overlap = Math.min(oEnd, t.start + (t.dur || 0)) - Math.max(o.start, t.start);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = t;
        }
      }
      if (best) out[i] = best.text;
    }
    return out;
  }

  // ---------- 加载并对齐原文 + 目标语言字幕 ----------
  async function loadTranscriptForCurrentVideo(force) {
    const vid = getVideoIdFromUrl();
    if (!vid) return;
    if (!force && state.videoId === vid && (state.transcript.length || state.loading)) return;

    state.loading = true;
    state.settings = await YTLB.getSettings();
    syncLang(state.settings);
    const payload = await requestCaptionAccess(vid);

    state.videoId = vid;
    state.videoTitle = (payload && payload.videoTitle) || document.title.replace(/ - YouTube$/, '');
    state.transcript = [];
    state.sentences = [];
    state.currentIndex = -1;
    state.lastAutoSavedIndex = -1;
    state.sourceLang = null;
    state.translationSource = 'none';
    state.failReason = null;
    state.outlineCache = null;

    const tracks = (payload && payload.tracks) || [];
    state.tracks = tracks;
    state.chapters = (payload && payload.chapters) || [];
    state.description = (payload && payload.description) || '';

    // 用户手动指定的原文轨道优先于自动识别。
    // 自动识别有三条依据：defaultAudioLanguage → ASR 轨道的语言 → 只有一条轨道时用它。
    // 多语言字幕的视频（TED-Ed 这类）三条可能全落空：14 条人工轨道、没有 ASR、
    // 也没有 defaultAudioLanguage，那时只能取列表第一条，而那个顺序和音频语言无关。
    // 所以必须留一个手动出口。
    const forced = await getForcedSource(vid);
    state.forcedSourceLang = forced;
    state.sourceLang = forced || detectSourceLang(payload);
    const track = pickSourceTrack(tracks, state.sourceLang);

    // 没有轨道 = 这个视频压根没字幕；有轨道但没模板 = 鉴权信息没拿到（需要明确提示，不能静默失败）
    if (!payload) {
      state.failReason = 'no-access'; // 桥接超时，通常是 inject.js 没能注入
      state.loading = false;
      return;
    }
    if (!track) {
      state.failReason = 'no-captions';
      state.loading = false;
      return;
    }
    if (!payload.template) {
      state.failReason = 'no-access';
      state.loading = false;
      return;
    }
    state.failReason = null;
    if (!state.sourceLang) state.sourceLang = YTLB.normalizeLang(track.languageCode);

    // 目标语言和原文相同时，回退到候选里的第一个 —— 把字幕翻译成它自己没有意义。
    // （试过"相同就不翻译、只显示原文"，但"只看译文"视图会变成空白，退回来了。）
    // 解释不受这条限制：explainTargetLang() 直接读设置值，英译英是成立的。
    const candidates = YTLB.candidateTargetLangs(state.sourceLang);
    const preferred = state.settings.targetLang;
    state.targetLang = candidates.includes(preferred) ? preferred : candidates[0];

    const origData = await fetchJson3(buildTimedTextUrl(payload.template, track.languageCode, track.kind));
    const originalEntries = origData ? parseEvents(origData) : [];
    if (!originalEntries.length) {
      state.failReason = 'empty-transcript';
      state.loading = false;
      return;
    }

    // 先尝试YouTube自己的免费机器翻译
    let targetEntries = [];
    if (!state.settings.qualityFirst) {
      targetEntries = await tryFetchTlang(payload.template, track, state.targetLang);
    }

    const alignedTargets = alignByTime(originalEntries, targetEntries);
    const covered = alignedTargets.filter(Boolean).length;
    const alignedOk = covered >= originalEntries.length * 0.7;

    state.transcript = originalEntries.map((e, i) => ({
      start: e.start,
      dur: e.dur,
      original: state.settings.autoClean ? YTLB.cleanFillerWords(e.text, state.sourceLang) : e.text,
      rawOriginal: e.text,
      target: alignedOk ? alignedTargets[i] : null,
    }));

    if (alignedOk) {
      state.translationSource = 'youtube';
    } else if (state.settings.qualityFirst && state.settings.apiKey) {
      state.translationSource = 'deepseek';
      await fillTranslationsViaDeepSeek(0, state.transcript.length);
    } else {
      state.translationSource = 'none';
    }

    rebuildSentences();
    state.loading = false;
  }

  // 分批调用 background 的 AI_TRANSLATE_BATCH，把结果写回 state.transcript[i].target
  async function fillTranslationsViaDeepSeek(startIdx, endIdx) {
    const CHUNK = 30;
    for (let i = startIdx; i < endIdx; i += CHUNK) {
      const slice = state.transcript.slice(i, Math.min(endIdx, i + CHUNK));
      const lines = slice.map((s) => s.original);
      try {
        const res = await send({
          type: 'YTLB_AI_TRANSLATE_BATCH',
          payload: {
            apiKey: state.settings.apiKey,
            baseUrl: state.settings.baseUrl,
            model: state.settings.translateModel,
            lines,
            sourceLang: state.sourceLang,
            targetLang: state.targetLang,
          },
        });
        if (res && res.ok) {
          res.translations.forEach((t, k) => {
            if (state.transcript[i + k]) state.transcript[i + k].target = t;
          });
        }
      } catch (e) {
        // 单个分段失败不影响其他分段
      }
    }
    rebuildSentences(); // 译文变了，句子里拼好的译文也要跟着更新
  }

  async function translateSingleLine(index) {
    const item = state.transcript[index];
    if (!item) return null;
    if (item.target) return item.target;
    if (!state.settings.apiKey) return null;
    try {
      const res = await send({
        type: 'YTLB_AI_TRANSLATE_BATCH',
        payload: {
          apiKey: state.settings.apiKey,
          baseUrl: state.settings.baseUrl,
          model: state.settings.translateModel,
          lines: [item.original],
          sourceLang: state.sourceLang,
          targetLang: state.targetLang,
        },
      });
      if (res && res.ok && res.translations[0]) {
        item.target = res.translations[0];
        rebuildSentences();
        return item.target;
      }
    } catch (e) {}
    return null;
  }

  // ---------- 保存到笔记 / 生词本 ----------
  // 字幕条的译文是后来才逐句填上的（点"翻译这句"、整篇翻译），
  // 所以句子索引在译文变化后要重建一次，否则句子里的译文会缺一半。
  function rebuildSentences() {
    state.sentences = YTLB.buildSentences(state.transcript);
  }

  // 无标点轨道的断句辅助：只在这种轨道上、且用户真的按了保存时才调一次 AI。
  // 有标点的轨道断句已经很准，不会走到这里，所以实际触发很少。
  async function refineSegmentWithAI(playTime, fallback) {
    const settings = state.settings || {};
    if (settings.aiSegment === false || !settings.apiKey) return null;

    // 取播放点之前的几条字幕拼成上下文，同时记住每条的偏移，方便把结果映射回时间
    const before = state.transcript.filter((e) => e.start <= playTime + 0.5).slice(-8);
    if (!before.length) return null;
    let text = '';
    const offsets = [];
    for (const e of before) {
      if (text) text += ' ';
      offsets.push({ off: text.length, start: e.start, end: e.start + (e.dur || 0) });
      text += e.original;
    }
    if (text.length > 600) {
      const cut = text.length - 600;
      text = text.slice(cut);
      offsets.forEach((o) => (o.off -= cut));
    }

    let sentence;
    try {
      const res = await send({
        type: 'YTLB_AI_SEGMENT',
        payload: {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.translateModel,
          text,
        },
      });
      if (!res || !res.ok || !res.sentence) return null;
      sentence = res.sentence;
    } catch (e) {
      return null;
    }

    // AI 可能改了大小写或标点，先精确找，再退到忽略大小写和标点的模糊找
    let at = text.lastIndexOf(sentence);
    if (at < 0) {
      const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const nText = norm(text);
      const nSent = norm(sentence);
      const nAt = nText.lastIndexOf(nSent);
      if (nAt < 0) return null; // 对不上就别用，回退到规则结果
      // 把归一化后的位置换算回原文位置
      let count = 0;
      for (let i = 0; i < text.length; i++) {
        if (/[\p{L}\p{N}]/u.test(text[i])) {
          if (count === nAt) {
            at = i;
            break;
          }
          count++;
        }
      }
      if (at < 0) return null;
      sentence = text.slice(at, at + Math.min(text.length - at, sentence.length + 20)).trim();
    }

    let start = fallback ? fallback.start : before[0].start;
    for (const o of offsets) if (o.off <= at) start = o.start;
    return { start, end: playTime, original: sentence, target: '', approximate: false, aiRefined: true };
  }

  // 按"完整句子"存笔记。offset=-1 表示改存再往前一句（点错了可以纠正）。
  // 当前显示的那条字幕属于哪一段。
  //
  // 不能再用 findSentenceAt(时间) —— 那个函数带 1.5 秒宽限：刚进入新句不到 1.5 秒时
  // 它返回**上一句**。本意是"人反应慢半拍"，但后果是画面上显示 A、按 N 存下来的是 B，
  // 用户没法预测自己会存到什么。规则只能有一条：**存的就是你看见的那一句**。
  // 迟了有「往前多存一句」和「撤销」兜底，那两个是显式的、可预期的。
  function sentenceIndexForCue(cueIndex, time) {
    const cands = [];
    for (let i = 0; i < state.sentences.length; i++) {
      const s = state.sentences[i];
      if (cueIndex >= s.fromIndex && cueIndex <= s.toIndex) cands.push(i);
    }
    if (!cands.length) return YTLB.findSentenceAt(state.sentences, time, 0); // 宽限设 0
    if (cands.length === 1) return cands[0];
    // 长句被切成几段时，它们共用同一个字幕条区间，按时间挑最近的那段
    let best = cands[0];
    let bestD = Infinity;
    for (const i of cands) {
      const s = state.sentences[i];
      const d = time < s.start ? s.start - time : time > s.end ? time - s.end : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  async function saveSentenceNote(offset) {
    const v = getVideoEl();
    if (!v || !state.sentences.length) return null;
    let idx = sentenceIndexForCue(state.currentIndex, v.currentTime);
    idx += offset || 0;
    if (idx < 0) idx = 0;
    if (idx >= state.sentences.length) idx = state.sentences.length - 1;
    let s = state.sentences[idx];
    if (!s) return null;

    // 规则切出来的只是近似片段时，让 AI 帮忙找真正的句子边界
    if (s.approximate && !offset) {
      const refined = await refineSegmentWithAI(v.currentTime, s);
      if (refined) s = refined;
    }

    const entries = await YTLB.getEntries();
    const entry = {
      id: YTLB.uid(),
      type: 'sentence',
      videoId: state.videoId,
      videoTitle: state.videoTitle,
      videoUrl: `https://www.youtube.com/watch?v=${state.videoId}&t=${Math.floor(s.start)}s`,
      time: s.start,
      sourceLang: state.sourceLang,
      targetLang: state.targetLang,
      original: s.original,
      translation: s.target || '',
      explainedWord: '',
      explanation: '',
      note: '',
      createdAt: Date.now(),
    };
    entries.push(entry);
    await YTLB.saveEntries(entries);
    // AI 调整过边界的话，实际存的起点和规则算出的 idx 已经对不上了，
    // 「往前多存一段」要按真实起点重新定位，否则会把内容接重复。
    const realIdx = s.aiRefined ? YTLB.findSentenceAt(state.sentences, s.start, 0.01) : idx;
    return { entry, index: realIdx, sentence: s };
  }

  // 找出包含某条字幕的那个句子（自动保存和生词本的例句都以句子为准，
  // 否则同一句话会被拆成好几条笔记重复存）
  function sentenceForCueIndex(index) {
    for (const s of state.sentences) {
      if (index >= s.fromIndex && index <= s.toIndex) return s;
    }
    return null;
  }

  // 解释类功能（点词、词组、悬停、详细）用哪种语言写。
  // 默认跟目标语言走；设成「用原文语言」时用源语言 —— 英语视频要英文解释这种单语学习方式。
  // 只影响解释，不影响字幕译文：字幕仍然要翻成你看得懂的那种语言。
  // 解释用哪种语言。注意这里读的是**设置里选的**目标语言，不是 state.targetLang ——
  // 后者被 candidateTargetLangs 过滤过，会把"和原文相同"的那个排除掉。
  // 那条规则只对**字幕翻译**成立（英语字幕翻成英语没意义），对**解释**不成立：
  // 用英文解释英文词就是学习词典的做法。
  //
  // 不区分的话会出现这个 bug：看英语视频、设置里选英语，解释却出中文 ——
  // 因为 en 被过滤掉后回退到了候选里的第一个。
  function explainTargetLang() {
    const s = state.settings || {};
    if (s.explainLang === 'source' && state.sourceLang) return state.sourceLang;
    return s.targetLang || state.targetLang;
  }


  // 详细解释要用的上下文：前两句 + 后一句。
  // 不给整篇 —— 那是白烧 token；也不能只给当前句 —— 典故和指代往往在前面交代过。
  // 前多后少是因为解释一个词时，"前面说了什么"比"后面接什么"有用得多。
  function contextAround(cueIndex, before = 2, after = 1) {
    if (!state.sentences.length) return '';
    let hit = 0;
    for (let i = 0; i < state.sentences.length; i++) {
      const s = state.sentences[i];
      if (cueIndex >= s.fromIndex && cueIndex <= s.toIndex) {
        hit = i;
        break;
      }
    }
    return state.sentences
      .slice(Math.max(0, hit - before), hit + after + 1)
      .map((s) => s.original)
      .join(' ')
      .slice(0, 900); // 硬上限，防止某句异常长把成本拉上去
  }

  // 挑出真正含有这个词的那一段，用作生词的来源例句。
  //
  // 不能直接用 sentenceForCueIndex：长句被 subdivideSentences 切开后，
  // 每一段沿用的都是**整句**的 fromIndex/toIndex，光靠字幕条下标分不出是哪一段，
  // 那个函数只会返回第一段 —— 于是例句里经常带着这个词前后好几句话。
  function segmentForWord(word, cueIndex, time) {
    const cands = state.sentences.filter((s) => cueIndex >= s.fromIndex && cueIndex <= s.toIndex);
    if (!cands.length) return null;
    const w = String(word || '').trim().toLowerCase();
    let pool = cands;
    if (w) {
      const hit = cands.filter((s) => String(s.original).toLowerCase().includes(w));
      if (hit.length) pool = hit;
    }
    if (pool.length === 1) return pool[0];
    // 同一个词在几段里都出现时，取离当前播放位置最近的那段
    if (typeof time !== 'number') return pool[0];
    let best = pool[0];
    let bestD = Infinity;
    for (const s of pool) {
      const d = time < s.start ? s.start - time : time > s.end ? time - s.end : 0;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // force=true 用于用户**主动点保存**的场景：这时不能受"自动保存"开关影响，
  // 否则关掉自动保存后，手动点保存会静默失效。
  async function autoSaveEntry(index, extra, force) {
    const settings = state.settings || (await YTLB.getSettings());
    if (!force && !settings.autoSave) return null;
    const item = state.transcript[index];
    if (!item) return null;
    const s = sentenceForCueIndex(index);
    const original = s ? s.original : item.original;
    const translation = s ? s.target || '' : item.target || '';
    const time = s ? s.start : item.start;

    const entries = await YTLB.getEntries();
    // 同一句话已经存过就不再重复存，只把新的解释补上去
    const dup = entries.find((e) => e.videoId === state.videoId && Math.abs(e.time - time) < 0.01 && e.original === original);
    if (dup) {
      const patch = extra || {};
      if (patch.explainedWord) {
        dup.explainedWord = patch.explainedWord;
        dup.explanation = patch.explanation || '';
      }
      if (!dup.translation && translation) dup.translation = translation;
      await YTLB.saveEntries(entries);
      return dup;
    }

    const entry = Object.assign(
      {
        id: YTLB.uid(),
        type: 'sentence',
        videoId: state.videoId,
        videoTitle: state.videoTitle,
        videoUrl: `https://www.youtube.com/watch?v=${state.videoId}&t=${Math.floor(time)}s`,
        time,
        sourceLang: state.sourceLang,
        targetLang: state.targetLang,
        original,
        translation,
        explainedWord: '',
        explanation: '',
        note: '',
        createdAt: Date.now(),
      },
      extra || {}
    );
    entries.push(entry);
    await YTLB.saveEntries(entries);
    return entry;
  }

  // 快捷添加用的查重：只看词本身，不区分来源视频。
  // 场景是"把这个生词记下来"，同一个词收藏两遍没有意义 ——
  // 而悬停时手一抖很容易连按两下，不查重的话生词本会被同一个词刷屏。
  async function findVocabByWord(word) {
    const w = normWord(word).toLowerCase();
    if (!w) return null;
    const all = await YTLB.getVocab();
    return all.find((v) => normWord(v.word).toLowerCase() === w) || null;
  }

  // ---------- 大纲缓存（持久化） ----------
  // 原来只放在 state.outlineCache 里，刷一次页面就没了，同一个视频得重新生成、重新花钱。
  // 而"每个视频只生成一次"是明确的成本要求，所以落到 storage 里。
  // 按 videoId + 目标语言分开存：换个目标语言，大纲的语言也不一样，不能复用。
  const OUTLINE_STORE = 'ytlb_outlines';
  const OUTLINE_KEEP = 40; // 只留最近这么多个，避免无限增长

  function outlineKey(videoId, lang) {
    return String(videoId || '') + '|' + String(lang || '');
  }

  function loadOutlineCache(videoId, lang) {
    if (!videoId) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [OUTLINE_STORE]: {} }, (res) => {
          const hit = (res[OUTLINE_STORE] || {})[outlineKey(videoId, lang)];
          resolve(hit ? hit.outline : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function saveOutlineCache(videoId, lang, outline) {
    if (!videoId || !outline) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [OUTLINE_STORE]: {} }, (res) => {
          const store = res[OUTLINE_STORE] || {};
          store[outlineKey(videoId, lang)] = { outline, at: Date.now() };
          // 超出上限就丢掉最旧的
          const keys = Object.keys(store);
          if (keys.length > OUTLINE_KEEP) {
            keys
              .sort((a, b) => (store[a].at || 0) - (store[b].at || 0))
              .slice(0, keys.length - OUTLINE_KEEP)
              .forEach((k) => delete store[k]);
          }
          chrome.storage.local.set({ [OUTLINE_STORE]: store }, resolve);
        });
      } catch (e) {
        resolve();
      }
    });
  }

  async function addVocabEntry({ index, word, explanation }) {
    const item = state.transcript[index];
    // 来源例句用重建出的句子，不用被切碎的那一条字幕；
    // 长句已经被切成几段时，取真正含有这个词的那一段，而不是笼统的第一段。
    const videoEl = getVideoEl();
    const s = segmentForWord(word, index, videoEl ? videoEl.currentTime : null) || sentenceForCueIndex(index);
    const vocab = await YTLB.getVocab();
    const v = {
      id: YTLB.uid(),
      word,
      sentenceOriginal: s ? s.original : item ? item.original : '',
      sentenceTranslation: s ? s.target || '' : item ? item.target || '' : '',
      explanation: explanation || '',
      videoId: state.videoId,
      videoTitle: state.videoTitle,
      time: s ? s.start : item ? item.start : 0,
      sourceLang: state.sourceLang,
      targetLang: state.targetLang,
      createdAt: Date.now(),
    };
    vocab.push(v);
    await YTLB.saveVocab(vocab);
    return v;
  }

  // ---------- 播放进度跟踪 ----------
  function getVideoEl() {
    return document.querySelector('video');
  }

  function tick() {
    const v = getVideoEl();
    if (!v || !state.transcript.length) return;
    const t = v.currentTime;
    const arr = state.transcript;
    let i = state.currentIndex < 0 ? 0 : state.currentIndex;
    while (i + 1 < arr.length && arr[i + 1].start <= t) i++;
    while (i > 0 && arr[i].start > t) i--;
    if (i !== state.currentIndex) {
      state.currentIndex = i;
      updateOverlay(arr[i]);
      // 侧边栏没打开时没有接收方，sendMessage 会 reject —— 必须 catch，否则控制台每句都刷一条错误
      try {
        const p = send({
          type: 'YTLB_SENTENCE_CHANGED',
          // 带上播放状态：暂停时侧边栏不该自动滚动（会把用户正在操作的下拉框滚走）
          payload: { videoId: state.videoId, videoTitle: state.videoTitle, index: i, entry: arr[i], playing: !v.paused },
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {}
    }
  }

  let lastSeenUrlVideoId = null;
  track(setInterval(async () => {
    const vid = getVideoIdFromUrl();
    if (vid && vid !== lastSeenUrlVideoId) {
      lastSeenUrlVideoId = vid;
      await loadTranscriptForCurrentVideo(true);
      ensureOverlay();
    }
    tick();
  }, 500));

  loadTranscriptForCurrentVideo(false);

  // ==================== 视频内浮层：双语字幕 + 点词弹窗 ====================
  let overlayEl = null;
  let popupEl = null;

  function ensureOverlay() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return;
    if (overlayEl && document.body.contains(overlayEl)) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'ytlb-overlay';
    overlayEl.innerHTML = `
      <button id="ytlb-save-btn" title="${T('ov.saveTip')}">${T('ov.save')}</button>
      <div class="ytlb-line ytlb-line-original" id="ytlb-line-original"></div>
      <div class="ytlb-line ytlb-line-target" id="ytlb-line-target"></div>
    `;
    player.appendChild(overlayEl);

    overlayEl.querySelector('#ytlb-save-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      doSaveSentence(0);
    });

    // 字幕大小跟着播放器尺寸走。全屏时播放器变大，字幕必须同比放大，
    // 否则在 1920 宽的画面上还是 15px，根本看不清。
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => scaleOverlay(player));
      ro.observe(player);
    }
    // 控制栏显示/隐藏靠 ytp-autohide 这个 class 切换，尺寸不变，
    // ResizeObserver 观察不到，得单独盯 class 的变化，否则鼠标一动字幕不会让位。
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => scaleOverlay(player));
      mo.observe(player, { attributes: true, attributeFilter: ['class'] });
    }
    scaleOverlay(player);

    popupEl = document.createElement('div');
    popupEl.id = 'ytlb-popup';
    popupEl.style.display = 'none';
    document.body.appendChild(popupEl);

    document.addEventListener('click', (e) => {
      if (popupEl && !popupEl.contains(e.target) && e.target.closest && !e.target.closest('.ytlb-word')) {
        closePopup();
      }
    });
    // Esc 关掉解释窗，比用鼠标去点空白处顺手
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popupEl && popupEl.style.display !== 'none') closePopup();
    });
  }

  // 点词看解释时把视频暂停 —— 边读解释边放，等读完已经错过好几句了。
  // 关掉解释窗再自动续播，不用手去够播放键。
  let pausedByPopup = false;

  function openPopup() {
    const settings = state.settings || {};
    const v = getVideoEl();
    if (settings.pauseOnExplain !== false && v && !v.paused) {
      v.pause();
      pausedByPopup = true;
    }
    positionPopup();
    popupEl.style.display = 'block';
  }

  function closePopup() {
    if (popupEl) popupEl.style.display = 'none';
    if (pausedByPopup) {
      pausedByPopup = false;
      const v = getVideoEl();
      if (v && v.paused) v.play().catch(() => {});
    }
  }

  // 放在字幕**上方**、播放器右侧。原来是跟着鼠标点击位置走，
  // 而点的就是字幕本身，弹窗正好盖住正在看的那一句。
  function positionPopup() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player || !popupEl) return;
    const pr = player.getBoundingClientRect();
    const or = overlayEl ? overlayEl.getBoundingClientRect() : null;

    popupEl.style.visibility = 'hidden';
    popupEl.style.display = 'block';
    const w = popupEl.offsetWidth || 300;
    const h = popupEl.offsetHeight || 120;
    popupEl.style.visibility = '';

    // 右对齐到播放器右边缘内侧
    let left = pr.right - w - 24;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));

    // 底边贴到字幕上沿之上，留 12px 间隙；字幕拿不到就退到播放器下部
    const anchorTop = or && or.top > pr.top ? or.top : pr.bottom - pr.height * 0.28;
    let top = anchorTop - h - 12;
    if (top < pr.top + 8) top = pr.top + 8; // 顶不下就贴播放器顶部，仍然不压字幕
    popupEl.style.left = left + 'px';
    popupEl.style.top = top + 'px';
  }

  // 按播放器宽度换算字号：默认尺寸(约850px)下 15px 左右，全屏(1920px)下 34px 左右，
  // 和 YouTube 自带字幕在各尺寸下的观感基本一致。上下限防止极端窗口下过大过小。
  function scaleOverlay(player) {
    if (!overlayEl || !player) return;
    const w = player.clientWidth || 854;
    const size = Math.max(13, Math.min(36, w * 0.018));
    overlayEl.style.setProperty('--ytlb-size', size.toFixed(1) + 'px');

    // 底边距不能用百分比。原来是 bottom:10%，播放器越矮这个值越小 ——
    // 小窗口下 10% 只有三四十像素，正好压在进度条上。而字幕行是 pointer-events:auto
    // （点词需要），于是它不只是挡住进度条，是真的把鼠标事件吃掉，拖不动。
    //
    // 改成按控制栏的真实高度算：控制栏显示时让开它，隐藏时（ytp-autohide）落回低位。
    const bar = player.querySelector('.ytp-chrome-bottom');
    const hidden = player.classList.contains('ytp-autohide');
    const barH = bar && !hidden ? bar.getBoundingClientRect().height : 0;
    const gap = Math.max(12, size * 0.6); // 控制栏之上留一点缝，别贴着
    // 控制栏藏起来时没东西要让，但也不能贴着画面底边，所以还有个下限
    const floor = Math.round((player.clientHeight || 480) * 0.07);
    const bottom = Math.max(floor, Math.round(barH + gap));
    overlayEl.style.setProperty('--ytlb-bottom', bottom + 'px');
  }

  function wrapWords(text) {
    return text
      .split(/(\s+)/)
      .map((tok) => (tok.trim() ? `<span class="ytlb-word">${YTLB.escapeHtml(tok)}</span>` : tok))
      .join('');
  }

  function updateOverlay(entry) {
    if (!overlayEl) return;
    const settings = state.settings || {};
    overlayEl.style.display = settings.overlayEnabled === false ? 'none' : 'flex';
    if (!entry) return;
    const origEl = overlayEl.querySelector('#ytlb-line-original');
    const targetElNode = overlayEl.querySelector('#ytlb-line-target');

    // 浮层要跟侧边栏的"原文 / 仅目标语言 / 双语对照"保持一致，
    // 否则会出现侧边栏已切成"仅目标语言"、视频上还挂着两行的情况。
    const mode = settings.viewMode || 'bilingual';
    origEl.style.display = mode === 'target' ? 'none' : '';
    targetElNode.style.display = mode === 'original' ? 'none' : '';

    origEl.innerHTML = wrapWords(entry.original);
    targetElNode.textContent = entry.target || (state.translationSource === 'none' ? T('ov.clickToTranslate') : '…');

    origEl.querySelectorAll('.ytlb-word').forEach((wEl) => {
      wEl.addEventListener('click', (e) => {
        e.stopPropagation();
        hideGlossTip();
        onWordClick(wEl.textContent, entry);
      });
      attachHoverGloss(wEl, entry);
    });
    targetElNode.onclick = async () => {
      if (!entry.target) {
        const idx = state.currentIndex;
        const t = await translateSingleLine(idx);
        if (t) targetElNode.textContent = t;
      }
    };
  }

  // 给"内容概括"准备输入。
  // 直接 slice 前 N 字符的话，两小时的视频只会概括到开头三分之一，
  // 而开头恰恰是赞助商口播、新书宣传这类无关内容 —— 实测就是这么翻车的。
  // 超长时按固定间隔跳着取，让整个时间轴都有代表。
  function buildSummaryInput(transcript, budget, withTime) {
    const line = (e) => (withTime ? `[${Math.round(e.start)}] ${e.original}` : e.original);
    const full = transcript.map(line).join(' ');
    if (full.length <= budget) return full;

    const keepRatio = budget / full.length;
    const out = [];
    let acc = 0;
    let carried = 0;
    for (const e of transcript) {
      carried += keepRatio;
      if (carried >= 1) {
        carried -= 1;
        const s = line(e);
        out.push(s);
        acc += s.length;
        if (acc >= budget) break;
      }
    }
    return out.join(' ');
  }

  // 把字幕按章节分组，每节取一段节选给 AI。
  // 每节单独限额，避免长的那一节把预算吃光、后面的章节没有内容可依据。
  function buildChapterExcerpts(chapters, transcript) {
    // 每节只要写一句话，喂太多是纯浪费 —— 输入是这个调用的成本大头。
    // 约 1200 字符（200 来个词）足够判断一节在讲什么。
    const perChapter = Math.min(1200, Math.max(400, Math.floor(26000 / chapters.length)));
    return chapters.map((c, i) => {
      const end = i + 1 < chapters.length ? chapters[i + 1].start : Infinity;
      const inRange = transcript.filter((e) => e.start >= c.start && e.start < end);
      let text = inRange.map((e) => e.original).join(' ');
      if (text.length > perChapter) {
        // 超了就在这一节内部均匀跳采，别只取这节的开头
        const ratio = perChapter / text.length;
        const picked = [];
        let carried = 0;
        for (const e of inRange) {
          carried += ratio;
          if (carried >= 1) {
            carried -= 1;
            picked.push(e.original);
          }
        }
        text = picked.join(' ');
      }
      return { start: c.start, title: c.title, excerpt: text };
    });
  }

  // AI 给的时间戳可能不存在于视频里（编造或算错）。
  // 吸附到最近的一条字幕，超出范围的直接丢掉，并保证时间递增。
  function snapItemsToTranscript(items) {
    if (!items || !items.length || !state.transcript.length) return items || [];
    const maxT = state.transcript[state.transcript.length - 1].start;
    const out = [];
    let lastStart = -1;
    for (const it of items) {
      let t = Number(it.start);
      if (!isFinite(t) || t < 0 || t > maxT + 60) continue;
      let best = state.transcript[0].start;
      let bestD = Infinity;
      for (const e of state.transcript) {
        const d = Math.abs(e.start - t);
        if (d < bestD) {
          bestD = d;
          best = e.start;
        }
      }
      if (best <= lastStart) continue; // 时间必须递增，否则是乱的
      lastStart = best;
      out.push({ start: best, title: it.title || '', summary: it.summary || '', ad: !!it.ad });
    }
    return out;
  }

  // ---------- 一键保存整句 + 确认提示 ----------
  // 存完要让用户看见"到底存了哪句"，否则那个"刚进入新句就算上一句"的判断会变成猜谜。
  let toastEl = null;
  let toastTimer = null;
  let lastSavedOffset = 0;

  function ensureToast() {
    if (toastEl && document.body.contains(toastEl)) return toastEl;
    toastEl = document.createElement('div');
    toastEl.id = 'ytlb-toast';
    toastEl.style.display = 'none';
    document.body.appendChild(toastEl);
    return toastEl;
  }

  // 点提示条以外的任何地方就收起 —— 比让人去瞄准那个 ✕ 快得多，
  // ✕ 留着是因为"点别处会关"这件事没人第一次就知道。
  let dismissHandler = null;
  function armDismissOnOutsideClick() {
    if (dismissHandler) return;
    dismissHandler = (e) => {
      if (toastEl && toastEl.contains(e.target)) return;
      hideToast();
    };
    // 延到下一轮再挂，否则触发保存的这一次点击自己就会把它关掉
    setTimeout(() => document.addEventListener('mousedown', dismissHandler, true), 0);
  }
  function disarmDismiss() {
    if (!dismissHandler) return;
    document.removeEventListener('mousedown', dismissHandler, true);
    dismissHandler = null;
  }

  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    disarmDismiss();
    if (toastEl) toastEl.style.display = 'none';
  }

  function renderToast(entryId, segIndex, text, startTime) {
    const t = ensureToast();
    t.innerHTML = `
      <button class="ytlb-toast-close" title="${YTLB.escapeHtml(T('ov.close'))}">✕</button>
      <div class="ytlb-toast-title">${T('ov.saved', { time: YTLB.formatTime(startTime) })}</div>
      <div class="ytlb-toast-text">${YTLB.escapeHtml(text.length > 120 ? text.slice(0, 120) + '…' : text)}</div>
      <div class="ytlb-toast-actions">
        ${segIndex > 0 ? '<button class="ytlb-toast-btn ytlb-toast-more">' + T('ov.more') + '</button>' : ''}
        <button class="ytlb-toast-btn ytlb-toast-undo">${T('ov.undo')}</button>
        <button class="ytlb-toast-btn ytlb-toast-copy">${T('ov.copy')}</button>
      </div>
    `;
    t.style.display = 'block';
    armDismissOnOutsideClick();
    t.querySelector('.ytlb-toast-close').onclick = hideToast;

    // 撤销比"改存前一句"覆盖面大：存错的原因不只是晚了一句，
    // 也可能是手滑、也可能这句根本不想要。
    t.querySelector('.ytlb-toast-undo').onclick = async () => {
      const all = await YTLB.getEntries();
      await YTLB.saveEntries(all.filter((x) => x.id !== entryId));
      lastSavedOffset = 0;
      flashToast(T('ov.undone'));
    };

    const more = t.querySelector('.ytlb-toast-more');
    if (more) more.onclick = () => extendNoteBackward(entryId, segIndex);
    const copy = t.querySelector('.ytlb-toast-copy');
    copy.onclick = () => {
      navigator.clipboard.writeText(text).then(
        () => {
          copy.textContent = T('ov.copied');
          if (toastTimer) clearTimeout(toastTimer);
          toastTimer = setTimeout(hideToast, 3000);
        },
        () => (copy.textContent = T('ov.copyFail'))
      );
    };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000); // 留足时间反复点"往前多存"
  }

  // 把前一段并进已存的这条笔记里（不是新增一条，也不是替换）
  async function extendNoteBackward(entryId, segIndex) {
    const prev = state.sentences[segIndex - 1];
    if (!prev) return;
    const entries = await YTLB.getEntries();
    const e = entries.find((x) => x.id === entryId);
    if (!e) return;
    e.original = (prev.original + ' ' + e.original).replace(/\s+/g, ' ').trim();
    if (prev.target) e.translation = (prev.target + ' ' + (e.translation || '')).trim();
    e.time = prev.start;
    e.videoUrl = `https://www.youtube.com/watch?v=${state.videoId}&t=${Math.floor(prev.start)}s`;
    await YTLB.saveEntries(entries);
    renderToast(entryId, segIndex - 1, e.original, prev.start);
  }

  async function doSaveSentence(offset) {
    const r = await saveSentenceNote(offset);
    if (!r) {
      const t = ensureToast();
      t.innerHTML = '<div class="ytlb-toast-title">' + YTLB.escapeHtml(T('ov.saveFail')) + '</div>';
      t.style.display = 'block';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 2500);
      return;
    }
    lastSavedOffset = offset || 0;
    renderToast(r.entry.id, r.index, r.sentence.original || '', r.sentence.start);
  }

  // ---------- 悬停速查 ----------
  // 点词出的完整解释要走 pro 档模型、内容长，天然慢。悬停这一层只要一个最短词义，
  // 用便宜的 flash 档模型，并且结果按 词+目标语言 缓存，同一个词第二次悬停是瞬时且免费的。
  const glossCache = new Map();
  let glossTipEl = null;
  let glossHoverTimer = null;
  let glossHideTimer = null;
  // 记住鼠标当前停在哪个词上。原来用自增序号判断"结果是否还有效"，
  // 但 mouseleave 会让序号立刻失效 —— 请求要一秒才回来，鼠标稍微一动结果就被丢了。
  let hoverWordEl = null;
  // 上面那个 hoverWordEl 只在"悬停取词"开着时才会被赋值（它在开关判断之后）。
  // 快捷添加生词不依赖那个开关，所以单独记一份，无条件更新。
  let hoverCtx = null; // { el, entry }

  function ensureGlossTip() {
    if (glossTipEl && document.body.contains(glossTipEl)) return glossTipEl;
    glossTipEl = document.createElement('div');
    glossTipEl.id = 'ytlb-gloss-tip';
    glossTipEl.style.display = 'none';
    // 气泡本身要能被鼠标停住，否则鼠标从词移向「＋」按钮的途中就把它关掉了
    glossTipEl.addEventListener('mouseenter', () => {
      if (glossHideTimer) clearTimeout(glossHideTimer);
    });
    glossTipEl.addEventListener('mouseleave', () => {
      if (glossHideTimer) clearTimeout(glossHideTimer);
      glossHideTimer = setTimeout(hideGlossTip, 300);
    });
    document.body.appendChild(glossTipEl);
    return glossTipEl;
  }

  function hideGlossTip() {
    if (glossHoverTimer) {
      clearTimeout(glossHoverTimer);
      glossHoverTimer = null;
    }
    hoverWordEl = null;
    if (glossTipEl) glossTipEl.style.display = 'none';
  }

  // withAdd=true 时在气泡里挂一个「＋」按钮：译文已经查回来了，
  // 这时候存生词不需要再花任何调用，顺手把译文一起存下。
  function showGlossTip(text, x, y, withAdd) {
    const tip = ensureGlossTip();
    tip.textContent = '';
    const span = document.createElement('span');
    span.className = 'ytlb-gloss-text';
    span.textContent = text;
    tip.appendChild(span);
    if (withAdd && hoverCtx) {
      const ctx = hoverCtx; // 按钮按下时鼠标可能已经不在词上了，先把上下文钉住
      const btn = document.createElement('button');
      btn.className = 'ytlb-gloss-add';
      btn.textContent = '＋';
      btn.title = T('ov.quickAdd');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        quickAddVocab(ctx, text);
        hideGlossTip();
      });
      tip.appendChild(btn);
    }
    tip.style.display = 'inline-flex';
    // 先显示再量宽度，避免超出屏幕右边
    const w = tip.offsetWidth || 120;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
    tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + 'px';
  }

  function normWord(w) {
    return String(w || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  // 零调用地把一个词/词组存进生词本。译文有就带上（悬停已经查过、钱花过了），
  // 没有就留空 —— 用户明确表示不需要解释时不该再去调 API。
  // 浮层的悬停+V 和侧边栏的划选+V 都走这里。
  async function quickAddWord(rawWord, index, gloss) {
    const word = normWord(rawWord);
    if (!word) return { ok: false };
    if (await findVocabByWord(word)) return { ok: true, dup: true, word };
    // 缓存键必须用解释语言，不是翻译目标语言 —— 两者可能不同
    const key = word.toLowerCase() + '|' + explainTargetLang();
    await addVocabEntry({ index, word, explanation: gloss || glossCache.get(key) || '' });
    return { ok: true, dup: false, word };
  }

  async function quickAddVocab(ctx, gloss) {
    if (!ctx || !ctx.el) return;
    // 悬停取词开着时，停在词上 350ms 就会发查词请求。用户按 V 是明确表示
    // "不用查，我知道意思"，所以把还没发出去的那次掐掉 —— 手快的话能省下这笔。
    // 但注意：超过 350ms 请求已经发出去了，那时候 V 省不了钱。
    if (glossHoverTimer) {
      clearTimeout(glossHoverTimer);
      glossHoverTimer = null;
    }
    // 例句要用悬停那个词所属的那一句，不能用 state.currentIndex ——
    // 按下 V 时视频可能已经播到下一句了，例句会跟着串位。
    const idx = ctx.entry ? state.transcript.indexOf(ctx.entry) : -1;
    const r = await quickAddWord(ctx.el.textContent, idx >= 0 ? idx : state.currentIndex, gloss);
    if (!r.ok) return;
    flashToast(T(r.dup ? 'ov.vocabDup' : 'ov.vocabAdded', { word: r.word }));
  }

  function flashToast(text) {
    const t = ensureToast();
    t.innerHTML = '<div class="ytlb-toast-title">' + YTLB.escapeHtml(text) + '</div>';
    t.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 2000);
  }

  function attachHoverGloss(wEl, entry) {
    wEl.addEventListener('mouseenter', () => {
      const settings = state.settings || {};
      // 先无条件记下"鼠标在哪个词上" —— 快捷键 V 靠它工作，
      // 和「悬停取词」开关无关（那个开关管的是要不要花钱查译文）。
      hoverCtx = { el: wEl, entry };
      if (settings.hoverGloss !== true) return; // 默认关闭，必须在设置里显式打开
      const word = normWord(wEl.textContent);
      // 单字母、纯数字这类查了也没意义，别浪费调用
      if (!word || word.length < 2 || /^\d+$/.test(word)) return;

      hoverWordEl = wEl; // 记住"鼠标现在在哪个词上"
      const key = word.toLowerCase() + '|' + explainTargetLang();
      const rect = wEl.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top;

      // 缓存命中就不用等，也不花钱
      if (glossCache.has(key)) {
        showGlossTip(glossCache.get(key), x, y, true);
        return;
      }
      if (!settings.apiKey) return;

      // 稍微延迟，避免鼠标扫过一整行时把每个词都查一遍
      if (glossHoverTimer) clearTimeout(glossHoverTimer);
      glossHoverTimer = setTimeout(async () => {
        if (hoverWordEl !== wEl) return; // 延迟期间已经移走了，请求都不用发
        showGlossTip('…', x, y);
        let res = null;
        try {
          res = await send({
            type: 'YTLB_AI_QUICK_GLOSS',
            payload: {
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: settings.translateModel,
              word,
              sentence: entry.original,
              targetLang: explainTargetLang(),
            },
          });
        } catch (err) {
          res = null;
        }
        // 结果先入缓存 —— 就算鼠标已经移开，这次调用的钱也没白花，
        // 下次再划过这个词就是瞬时且免费的。
        if (res && res.ok && res.gloss) glossCache.set(key, res.gloss);
        // 只有鼠标还停在同一个词上才显示
        if (hoverWordEl !== wEl) return;
        if (res && res.ok && res.gloss) {
          showGlossTip(res.gloss, x, y, true);
        } else {
          // 失败也要看得见。原来这里直接 hideGlossTip()，
          // 结果无论是扩展失效、没配 Key 还是接口报错，用户看到的都是"什么都没有"。
          const why = (res && res.error) || T('ov.explainFail');
          showGlossTip('⚠ ' + String(why).slice(0, 60), x, y);
          if (glossHideTimer) clearTimeout(glossHideTimer);
          glossHideTimer = setTimeout(hideGlossTip, 3000);
        }
      }, 350);
    });

    wEl.addEventListener('mouseleave', () => {
      if (hoverWordEl === wEl) hoverWordEl = null;
      if (hoverCtx && hoverCtx.el === wEl) hoverCtx = null;
      // 不立刻隐藏：鼠标从词上挪开一两像素就让气泡消失，会显得很难用。
      // 给一点缓冲，期间如果又停到别的词上，那次 mouseenter 会接管。
      if (glossHideTimer) clearTimeout(glossHideTimer);
      glossHideTimer = setTimeout(() => {
        if (!hoverWordEl) hideGlossTip();
      }, 400);
    });
  }

  async function onWordClick(word, entry) {
    if (!popupEl) return;
    // 关掉「点字幕里的词弹出解释」之后，点词不做任何事 ——
    // 这是最主要的花钱路径，而且字幕上的词很密，误点很容易。
    if ((state.settings || {}).clickExplain === false) return;
    popupEl.innerHTML = `<div class="ytlb-popup-word">${YTLB.escapeHtml(word)}</div><div class="ytlb-popup-loading">${T('ov.explaining')}</div>`;
    openPopup();

    const settings = state.settings || (await YTLB.getSettings());
    if (!settings.apiKey) {
      popupEl.innerHTML = `<div class="ytlb-popup-word">${YTLB.escapeHtml(word)}</div><div class="ytlb-popup-err">${T('ov.noKey')}</div>`;
      return;
    }
    try {
      const res = await send({
        type: 'YTLB_AI_EXPLAIN_WORD',
        payload: {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.reasonModel,
          word,
          sentence: entry.original,
          sourceLang: state.sourceLang,
          targetLang: explainTargetLang(),
        },
      });
      if (res && res.ok) {
        // 点一个词是**词汇**行为，不是笔记行为 —— 所以自动保存的去向是生词本。
        // 之前进的是笔记，结果笔记里堆满了单个词，而生词本反倒要手动点才有。
        // 笔记留给"我想记住这句话"这种明确的动作（按 N 或点下面的「＋笔记」）。
        let saved = false;
        if (settings.autoSave) {
          const r = await quickAddWord(word, state.currentIndex, res.explanation);
          saved = !!(r && r.ok);
        }
        popupEl.innerHTML = `
          <div class="ytlb-popup-word">${YTLB.escapeHtml(word)}</div>
          <div class="ytlb-popup-explain">${YTLB.escapeHtml(res.explanation)}</div>
          ${saved ? '<div class="ytlb-popup-saved">' + T('ov.autoSaved') + '</div>' : ''}
          <button class="ytlb-popup-save">${T('ov.addNote')}</button>
        `;
        popupEl.querySelector('.ytlb-popup-save').onclick = async () => {
          // 生词在上面已经自动存过了，这个按钮负责的是把**整句**存进笔记
          await doSaveSentence(0);
          popupEl.querySelector('.ytlb-popup-save').textContent = T('ov.addedNote');
          // 存完就收起卡片，视频自动续播 —— 这是卡片上的最后一个动作，
          // 还要再点一次关闭纯属多余。留半秒是为了让"已存✓"能被看见。
          setTimeout(closePopup, 500);
        };
      } else {
        popupEl.innerHTML = `<div class="ytlb-popup-word">${YTLB.escapeHtml(word)}</div><div class="ytlb-popup-err">${YTLB.escapeHtml((res && res.error) || T('ov.explainFail'))}</div>`;
      }
    } catch (e) {
      popupEl.innerHTML = `<div class="ytlb-popup-word">${YTLB.escapeHtml(word)}</div><div class="ytlb-popup-err">${YTLB.escapeHtml(T('ov.reqFail', { reason: e.message || String(e) }))}</div>`;
    }
    // 内容填进去之后高度变了，重新算一次位置，保证底边仍然压在字幕上方
    positionPopup();
  }

  // 在 chrome://extensions 里点过"刷新"之后，页面上残留的是**上一个版本**的内容脚本，
  // 它和扩展之间的连接已经断了，任何 chrome.runtime.* 调用都会抛错。
  // 这种情况必须刷新页面才能恢复，跟"要不要点工具栏图标"没关系，得分开提示。
  function isContextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // 页面上的悬浮入口按钮：不用去工具栏找插件图标，直接在YouTube页面上点它就能打开侧边栏
  function ensureLauncher() {
    if (document.getElementById('ytlb-launcher')) return;
    const btn = document.createElement('button');
    btn.id = 'ytlb-launcher';
    btn.textContent = T('ov.launcher');
    btn.title = T('ov.launcherTip');

    function flash(text, ms) {
      btn.textContent = text;
      setTimeout(() => (btn.textContent = T('ov.launcher')), ms || 2500);
    }

    // sidePanel.open() 必须在用户手势里调用，而手势是通过 sendMessage 传给 service worker 的。
    // 如果 service worker 正好处于休眠（插件刚刷新、或闲置一会儿之后），
    // 它得先冷启动，等它醒来时手势上下文已经过期了 —— 这就是"刷新后第一次点没反应"的原因。
    // 所以在 mousedown 时先发个 ping 把它叫醒，等 click 真正触发时它已经是活的了。
    btn.addEventListener('mousedown', () => {
      if (!isContextAlive()) return;
      try {
        send({ type: 'YTLB_PING' });
      } catch (e) {}
    });

    btn.addEventListener('click', async () => {
      if (!isContextAlive()) {
        flash(T('ov.reloadPage'), 4000);
        return;
      }
      btn.textContent = T('ov.opening');
      try {
        const r = await send({ type: 'YTLB_OPEN_PANEL' });
        if (r && r.ok) {
          btn.textContent = T('ov.launcher');
          return;
        }
        // 打不开时把后台返回的真实原因打到控制台，方便直接定位，不用猜
        const err = String((r && r.error) || T('st.unknownError'));
        console.warn('[Lingopal] 打开侧边栏失败：', err);
        flash(/gesture|user action/i.test(err) ? T('ov.clickAgain') : T('ov.useToolbar'), 3000);
      } catch (e) {
        console.warn('[Lingopal] 打开侧边栏异常：', e);
        flash(isContextAlive() ? T('ov.useToolbar') : T('ov.reloadPage'), 4000);
      }
    });
    document.body.appendChild(btn);
  }
  ensureLauncher();
  track(setInterval(ensureLauncher, 3000));

  // 全屏时把入口按钮藏起来：全屏下侧边栏根本打不开，按钮留着只会压在画面上。
  // 退出全屏自动恢复。
  function syncLauncherVisibility() {
    const btn = document.getElementById('ytlb-launcher');
    if (!btn) return;
    btn.style.display = document.fullscreenElement ? 'none' : '';
  }
  document.addEventListener('fullscreenchange', syncLauncherVisibility);
  syncLauncherVisibility();

  // 设置的唯一真相是存储本身。
  //
  // 原来全靠侧边栏发 YTLB_SETTINGS_CHANGED 通知，只要有一条写入路径忘了发消息、
  // 或者消息在传递中丢了，页面上的状态就和存储对不上 —— 实测出现过侧边栏已经切成
  // "只看原文"、视频浮层还挂着两行译文，而且刷新也不好（因为存储里其实是对的，
  // 只是内存里的 state.settings 没跟上）。
  // 直接监听存储，谁写的都能跟上，以后新增写入路径也不用记得补通知。
  // 设置页改了「默认目标语言」时，当前视频必须跟着重译。
  // 字幕栏那个下拉框走的是 YTLB_SET_TARGET_LANG，它自己会重载；
  // 设置页这条路以前只更新了 state.settings 就完事，state.targetLang 纹丝不动 ——
  // 表现是"设置里换成英语，字幕和解释还是原来那种语言，非刷新页面不可"。
  // 而且解释那条路读的是设置值，字幕读的是 state 值，两边会不一致。
  let applyingTargetLang = false;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.ytlb_settings || !isContextAlive()) return;
    const next = changes.ytlb_settings.newValue;
    if (!next) return;
    const prevTarget = (state.settings || {}).targetLang;
    state.settings = Object.assign({}, YTLB.DEFAULT_SETTINGS, next);
    syncLang(state.settings);
    updateOverlay(state.transcript[state.currentIndex] || null);
    // applyingTargetLang：下拉框那条路已经在重载了，别再触发一次
    if (!applyingTargetLang && state.videoId && next.targetLang && next.targetLang !== prevTarget) {
      loadTranscriptForCurrentVideo(true);
    }
  });

  // 快捷键：N 存笔记、R 重放当前这一句、V 存生词（悬停时）
  //
  // 必须用**捕获阶段**（addEventListener 第三个参数 true）。
  // 冒泡阶段注册的话，点过视频之后焦点落在播放器上，YouTube 挂在播放器元素上的
  // 键盘处理会先跑，它对一部分按键调了 stopPropagation，事件就到不了 document ——
  // 表现正是"有时按 N 有反应、有时没有"，而点浮层上的 Note 按钮永远正常
  // （那条路根本不经过键盘事件）。捕获阶段是 document → … → 目标，我们永远先拿到。
  document.addEventListener('keydown', (e) => {
    // 正在输入框里打字时不能抢键，否则写笔记打个 n 就触发保存了
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    // R：重放当前这一句（按整句回跳，不是按被切碎的字幕条）。
    // 和 N 一样只认不带修饰键的按法 —— 上面已经挡掉了输入框里的按键。
    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      const v = getVideoEl();
      if (!v) return;
      // 不带修饰键的 R 也是 YouTube 可能用到的键位，抢过来自己处理
      e.preventDefault();
      e.stopPropagation();
      const si = YTLB.findSentenceAt(state.sentences, v.currentTime, 0.4);
      const s = state.sentences[si];
      const item = state.transcript[state.currentIndex];
      const target = s ? s.start : item ? item.start : null;
      if (target != null) {
        v.currentTime = target;
        v.play().catch(() => {});
      }
      return;
    }

    // N：把刚说完的这段存进笔记。
    // 只认没带任何修饰键的 N —— YouTube 自己用 Shift+N 跳下一个视频，
    // 上面已经挡掉了输入框里的按键，所以写笔记时打 n 不会误触发。
    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      e.stopPropagation();
      doSaveSentence(0);
      return;
    }

    // V：把鼠标当前停着的那个词存进生词本。零 API 调用 ——
    // 用于"我已经知道这个词什么意思，只想记下来"。悬停取词查过的话顺手带上译文。
    // 鼠标没停在词上就什么都不做，不给提示（按错键不该弹东西）。
    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      if (!hoverCtx) return;
      e.preventDefault();
      e.stopPropagation();
      quickAddVocab(hoverCtx, null);
    }
  }, true);

  // ==================== 消息处理（供 sidepanel 调用） ====================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'YTLB_GET_STATE') {
      const cur = state.currentIndex >= 0 ? state.transcript[state.currentIndex] : null;
      sendResponse({
        videoId: state.videoId,
        videoTitle: state.videoTitle,
        url: location.href,
        sourceLang: state.sourceLang,
        targetLang: state.targetLang,
        explainLangUsed: explainTargetLang(), // 解释实际用的语言，和字幕译文可能不同
        tracks: state.tracks,
        forcedSourceLang: state.forcedSourceLang,
        translationSource: state.translationSource,
        failReason: state.failReason,
        loading: state.loading,
        currentIndex: state.currentIndex,
        currentEntry: cur,
        transcriptLength: state.transcript.length,
        chapters: state.chapters,
        hasVideo: !!getVideoEl(),
        playing: !!(getVideoEl() && !getVideoEl().paused),
      });
      return true;
    }

    if (msg.type === 'YTLB_GET_TRANSCRIPT') {
      sendResponse({
        videoId: state.videoId,
        videoTitle: state.videoTitle,
        sourceLang: state.sourceLang,
        targetLang: state.targetLang,
        translationSource: state.translationSource,
        entries: state.transcript,
      });
      return true;
    }

    // 用户手动指定原文轨道。传 null 表示回到自动识别。
    if (msg.type === 'YTLB_SET_SOURCE_LANG') {
      setForcedSource(state.videoId, msg.lang || null).then(async () => {
        await loadTranscriptForCurrentVideo(true);
        sendResponse({ ok: true, sourceLang: state.sourceLang, targetLang: state.targetLang });
      });
      return true;
    }

    if (msg.type === 'YTLB_SET_TARGET_LANG') {
      // 举旗告诉 storage.onChanged：这次重载我自己来，别重复触发一次
      applyingTargetLang = true;
      YTLB.saveSettings({ targetLang: msg.lang })
        .then(async () => {
          await loadTranscriptForCurrentVideo(true);
          sendResponse({ ok: true, targetLang: state.targetLang, translationSource: state.translationSource });
        })
        .finally(() => {
          applyingTargetLang = false;
        });
      return true;
    }

    // 侧边栏切换"原文/仅目标语言/双语对照"时立刻同步到视频浮层，不需要重开插件
    if (msg.type === 'YTLB_SET_VIEW_MODE') {
      YTLB.saveSettings({ viewMode: msg.mode }).then((s) => {
        state.settings = s;
        syncLang(s);
        updateOverlay(state.transcript[state.currentIndex] || null);
        sendResponse({ ok: true, viewMode: s.viewMode });
      });
      return true;
    }

    // 侧边栏字幕列表里的悬停速查（和视频浮层共用同一份缓存与模型档位）
    if (msg.type === 'YTLB_QUICK_GLOSS') {
      (async () => {
        const settings = state.settings || (await YTLB.getSettings());
        const item = state.transcript[msg.index];
        if (!item) return sendResponse({ ok: false, error: T('st.sentenceNotFound') });
        const word = normWord(msg.word);
        const key = word.toLowerCase() + '|' + explainTargetLang();
        if (glossCache.has(key)) return sendResponse({ ok: true, gloss: glossCache.get(key), cached: true });
        if (!settings.apiKey) return sendResponse({ ok: false, error: T('st.noApiKey') });
        try {
          const res = await send({
            type: 'YTLB_AI_QUICK_GLOSS',
            payload: {
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: settings.translateModel,
              word,
              sentence: item.original,
              targetLang: explainTargetLang(),
            },
          });
          if (res && res.ok && res.gloss) glossCache.set(key, res.gloss);
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'YTLB_TRANSLATE_LINE') {
      translateSingleLine(msg.index).then((t) => sendResponse({ ok: !!t, target: t }));
      return true;
    }

    if (msg.type === 'YTLB_TRANSLATE_AND_SAVE') {
      (async () => {
        const t = await translateSingleLine(msg.index);
        // autoSaveEntry 在"自动保存"关掉时返回 null，调用方要据此决定提示语
        const entry = await autoSaveEntry(msg.index, {});
        sendResponse({ ok: true, target: t, entry: entry || null });
      })();
      return true;
    }

    if (msg.type === 'YTLB_SAVE_MANUAL') {
      autoSaveEntry(msg.index, { note: msg.note || '' }, true).then((entry) => sendResponse({ ok: !!entry, entry }));
      return true;
    }

    // 侧边栏「重放这句」：按整句回跳，不然会从半句开始播
    if (msg.type === 'YTLB_REPLAY_SENTENCE') {
      const v = getVideoEl();
      if (!v) return sendResponse({ ok: false });
      const si = YTLB.findSentenceAt(state.sentences, v.currentTime, 0.4);
      const s = state.sentences[si];
      const item = state.transcript[state.currentIndex];
      const t = s ? s.start : item ? item.start : null;
      if (t == null) return sendResponse({ ok: false });
      v.currentTime = t;
      v.play().catch(() => {});
      sendResponse({ ok: true, time: t });
      return true;
    }

    // 侧边栏按 N 转发过来的。焦点在侧边栏时（点过时间戳、滚过列表）页面收不到按键，
    // 侧边栏又是独立文档 —— 于是 N 静默失效，连失败提示都没有。转到这里走的是
    // 和页面上按 N 完全同一条路，保证两边行为一致。
    if (msg.type === 'YTLB_SAVE_HOTKEY') {
      doSaveSentence(0);
      sendResponse({ ok: true });
      return true;
    }

    // 详细解释：比点词解释多给上下文、多放输出。手动触发，不自动跑。
    if (msg.type === 'YTLB_EXPLAIN_DEEP') {
      (async () => {
        const settings = state.settings || (await YTLB.getSettings());
        // msg.sentence 让侧边栏能直接传句子进来 —— 生词卡片里那条例句
        // 可能来自别的视频，那时 state.transcript 里根本没有它
        const item = state.transcript[msg.index];
        const sentence = msg.sentence || (item && item.original) || '';
        if (!sentence) return sendResponse({ ok: false, error: T('st.sentenceNotFound') });
        try {
          const res = await send({
            type: 'YTLB_AI_EXPLAIN_DEEP',
            payload: {
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: settings.reasonModel,
              word: msg.word,
              sentence,
              context: msg.index >= 0 ? contextAround(msg.index) : '',
              sourceLang: state.sourceLang,
              targetLang: explainTargetLang(),
              // 卡片上已有点词解释时，让它跳过词义和字面构成，别让用户为同样的内容付两次
              hasBrief: !!msg.hasBrief,
            },
          });
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'YTLB_EXPLAIN_WORD') {
      (async () => {
        const settings = state.settings || (await YTLB.getSettings());
        const item = state.transcript[msg.index];
        if (!item) return sendResponse({ ok: false, error: T('st.sentenceNotFound') });
        try {
          const res = await send({
            type: 'YTLB_AI_EXPLAIN_WORD',
            payload: {
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: settings.reasonModel,
              word: msg.word,
              sentence: item.original,
              sourceLang: state.sourceLang,
              targetLang: explainTargetLang(),
            },
          });
          // 和视频上点词一样：解释的结果进**生词本**，不进笔记。
          // 侧边栏的「词组解释」和字幕行里的解释都走这条消息，上一轮只改了
          // 视频浮层那条路径，这里漏了 —— 于是划选出来的词组还在往笔记里堆。
          if (res && res.ok && settings.autoSave) {
            await quickAddWord(msg.word, msg.index, res.explanation);
          }
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }

    // 侧边栏"当前句"里划选 + 按 V。走 quickAddWord 是为了带上查重 ——
    // 和解释卡片上的「＋生词」不同，这个入口按一下就存，很容易重复触发。
    if (msg.type === 'YTLB_QUICK_ADD_VOCAB') {
      quickAddWord(msg.payload.word, msg.payload.index, msg.payload.explanation || null).then(sendResponse);
      return true;
    }
    if (msg.type === 'YTLB_ADD_VOCAB') {
      addVocabEntry(msg.payload).then((v) => sendResponse({ ok: true, vocab: v }));
      return true;
    }

    if (msg.type === 'YTLB_GET_OUTLINE') {
      (async () => {
        if (state.outlineCache) return sendResponse({ ok: true, outline: state.outlineCache, cached: true });
        // 内存缓存刷新页面就没了，所以再查一次持久缓存
        const saved = await loadOutlineCache(state.videoId, state.targetLang);
        if (saved) {
          state.outlineCache = saved;
          return sendResponse({ ok: true, outline: saved, cached: true });
        }
        const settings = state.settings || (await YTLB.getSettings());
        if (!settings.apiKey) return sendResponse({ ok: false, error: T('st.noApiKey') });
        const hasChapters = state.chapters && state.chapters.length;
        // 有章节：按章节切分字幕，AI 只填"这节讲了什么"，时间戳仍用 YouTube 的。
        // 没章节：沿整个时间轴均匀取样（不能截开头，开头往往正好是广告口播）。
        const payload = {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.translateModel, // 概括用便宜的 flash 档就够
          targetLang: state.targetLang,
          transcriptText: hasChapters ? '' : buildSummaryInput(state.transcript, 45000, true),
          chapters: hasChapters ? buildChapterExcerpts(state.chapters, state.transcript) : null,
          description: state.description || '',
        };
        try {
          const res = await send({ type: 'YTLB_AI_OUTLINE', payload });
          if (res && res.ok) {
            // 没章节时时间戳是 AI 给的，可能编错 —— 校验并吸附到最近的一句字幕
            if (res.outline && res.outline.source === 'ai') {
              res.outline.items = snapItemsToTranscript(res.outline.items);
            }
            state.outlineCache = res.outline;
            await saveOutlineCache(state.videoId, state.targetLang, res.outline);
          }
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'YTLB_TRANSLATE_ALL') {
      (async () => {
        const settings = state.settings || (await YTLB.getSettings());
        if (!settings.apiKey) return sendResponse({ ok: false, error: T('st.noApiKey') });
        await fillTranslationsViaDeepSeek(0, state.transcript.length);
        state.translationSource = 'deepseek';
        sendResponse({ ok: true, entries: state.transcript });
      })();
      return true;
    }

    if (msg.type === 'YTLB_RELOAD_TRANSCRIPT') {
      loadTranscriptForCurrentVideo(true).then(() => {
        sendResponse({ videoId: state.videoId, transcriptLength: state.transcript.length, translationSource: state.translationSource });
      });
      return true;
    }

    if (msg.type === 'YTLB_SEEK') {
      const v = getVideoEl();
      if (v && typeof msg.time === 'number') {
        v.currentTime = Math.max(0, msg.time);
        v.play().catch(() => {});
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'YTLB_SETTINGS_CHANGED') {
      YTLB.getSettings().then((s) => {
        state.settings = s;
        syncLang(s);
        // 走 updateOverlay 而不是只改 display，这样视图模式等设置也会一并生效
        updateOverlay(state.transcript[state.currentIndex] || null);
        sendResponse({ ok: true });
      });
      return true;
    }
  });
})();
