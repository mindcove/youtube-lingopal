// utils.js
// 公共工具函数：给 content.js 和 sidepanel.js 共用（都以普通 <script> / content_scripts 方式加载，
// 所以这里不用 ES module 的 import/export，直接挂在一个全局命名空间 YTLB 上）。

(function (root) {
  const YTLB = root.YTLB || {};

  // ---------- 存储相关 ----------
  const DEFAULT_SETTINGS = {
    uiLang: 'auto', // 'auto' = 跟随浏览器语言；也可以是 'zh' / 'en'
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    // 便宜、够用，用于"翻译整篇字幕"这类批量、对创造力要求不高的任务
    translateModel: 'deepseek-v4-flash',
    // 更强，用于"解释生词/概念"和"生成大纲"这类需要理解语境、给出高质量输出的任务
    reasonModel: 'deepseek-v4-pro',
    targetLang: '', // '' = 还没选定，由 sidepanel 首次使用时引导用户选择
    qualityFirst: false, // true = 整句/整篇翻译也优先走 DeepSeek，而不是 YouTube 免费机翻
    autoClean: true, // 语气词/重复词规则清洗
    autoSave: true, // 你翻译/解释过的句子自动存入笔记，不需要再手动点保存
    overlayEnabled: true, // 视频画面上的双语字幕浮层
    viewMode: 'bilingual', // 'bilingual' | 'original' | 'target'，同时作用于字幕列表和视频浮层
    // 悬停速查默认关闭。它是唯一"不需要明确点击就会调用 API"的功能，
    // 鼠标划过字幕就会逐词触发，开销累积得很快且用户无感知，所以改成显式opt-in。
    hoverGloss: false,
    // 点词解释默认开着 —— 它是这个插件的主功能。
    // 但必须给一个关闭出口：它是最主要的花钱路径，而且点字幕里的词很容易误触。
    clickExplain: true,
    // 解释用什么语言写：'target' 跟随目标语言（默认），'source' 用原文语言。
    // 后者是给「英语视频要英文解释」这类单语学习方式准备的 —— 到了一定水平，
    // 用母语解释反而是干扰。和目标语言分开设，因为字幕译文仍然要翻成你看得懂的。
    explainLang: 'target',
    followPlayback: true, // 字幕列表跟随播放自动滚动
    stickyCurrent: true, // 当前句卡片固定在面板顶部，字幕列表滚动时不跟着走
    pauseOnExplain: true, // 点词看解释时自动暂停视频，关掉解释窗再续播
    setupSkipped: false, // 用户点过"先跳过"，之后不再自动跳到设置页
    // 无标点字幕（老式自动字幕）保存笔记时，让 AI 找真正的句子边界。
    // 纯规则判断不了"这句说完没有"，只能靠它。有标点的视频不会触发。
    // 没有做成设置项：只在"老式无标点字幕 + 按 N 存笔记"同时成立时触发一次，
    // 单次约 ¥0.0005，为它占一行设置的注意力成本比它花的钱还高。
    aiSegment: true,
  };

  const LANG_NAMES = { en: '英语', fr: '法语', zh: '中文' };
  const SUPPORTED_LANGS = ['en', 'fr', 'zh'];

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ ytlb_settings: DEFAULT_SETTINGS }, (res) => {
        resolve(Object.assign({}, DEFAULT_SETTINGS, res.ytlb_settings || {}));
      });
    });
  }

  function saveSettings(patch) {
    return getSettings().then((cur) => {
      const next = Object.assign({}, cur, patch);
      return new Promise((resolve) => {
        chrome.storage.local.set({ ytlb_settings: next }, () => resolve(next));
      });
    });
  }

  function getEntries() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ ytlb_entries: [] }, (res) => resolve(res.ytlb_entries || []));
    });
  }

  function saveEntries(entries) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ ytlb_entries: entries }, () => resolve(entries));
    });
  }

  function getVocab() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ ytlb_vocab: [] }, (res) => resolve(res.ytlb_vocab || []));
    });
  }

  function saveVocab(vocab) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ ytlb_vocab: vocab }, () => resolve(vocab));
    });
  }

  function uid() {
    return 'x' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  // ---------- 目标语言候选逻辑 ----------
  // sourceLang: 视频字幕检测到的语言代码（如 'en','fr','zh','es'...，可能拿不到就是 null）
  // 规则（用户确认过的）：
  //   目标语言候选 = {en, fr, zh} 去掉源语言本身
  //   如果源语言不在 {en, fr, zh} 里，候选固定给一个 zh + 用户在 en/fr 里二选一
  //   目标语言不会等于源语言，相同的选项直接不出现
  function normalizeLang(code) {
    if (!code) return null;
    const c = code.toLowerCase();
    if (c.startsWith('en')) return 'en';
    if (c.startsWith('fr')) return 'fr';
    if (c.startsWith('zh')) return 'zh';
    return c.slice(0, 2);
  }

  function candidateTargetLangs(sourceLangRaw) {
    const source = normalizeLang(sourceLangRaw);
    if (source && SUPPORTED_LANGS.includes(source)) {
      return SUPPORTED_LANGS.filter((l) => l !== source);
    }
    // 源语言是英/法/中之外的语言（或未知）：固定给中文 + en/fr 二选一
    return ['zh', 'en', 'fr'].filter((l) => l !== source);
  }

  // ---------- 语气词 / 重复词清洗（纯规则，不调用AI） ----------
  // 每种语言一份"口头语气词"词表，做整词匹配去除；另外做相邻重复词折叠（"我 我 觉得" -> "我 觉得"）。
  const FILLER_WORDS = {
    en: [
      'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'like', 'you know',
      'i mean', 'sort of', 'kind of', 'basically', 'actually', 'right,', 'okay so',
    ],
    fr: [
      'euh', 'ben', 'bah', 'hein', 'tu vois', 'tu sais', 'du coup', 'en fait',
      'genre', 'quoi', 'voilà', 'donc voilà',
    ],
    zh: ['呃', '嗯', '啊', '那个', '就是说', '这个', '然后呢', '就是', '其实呢', '怎么说呢'],
  };

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function cleanFillerWords(text, lang) {
    if (!text) return text;
    let out = text;
    const words = FILLER_WORDS[normalizeLang(lang)] || [];
    // 按长度从长到短替换，避免 "you know" 里的 "know" 之类被短词提前吃掉
    const sorted = [...words].sort((a, b) => b.length - a.length);
    for (const w of sorted) {
      const isCJK = /[一-鿿]/.test(w);
      const pattern = isCJK
        ? new RegExp(escapeRegExp(w), 'g')
        : new RegExp('\\b' + escapeRegExp(w) + '\\b', 'gi');
      out = out.replace(pattern, ' ');
    }
    // 折叠相邻重复的词（处理口误式重复，如 "the the cat" / "我 我 觉得"）
    out = out.replace(/\b(\w+)\b(\s+\1\b)+/gi, '$1');
    // 折叠多余空格/标点前空格
    out = out.replace(/\s+/g, ' ').replace(/\s+([,.!?，。！？])/g, '$1').trim();
    return out;
  }

  // ---------- 字幕条 → 完整句子（纯规则，不调用AI） ----------
  // YouTube 的字幕是"显示单元"不是"语言单元"，一句话经常被切成好几条：
  //   [23.0s] Now, becoming a parent is
  //   [25.2s] an amazing experience.
  // 记笔记要的是完整的一句话，所以这里把相邻字幕条按句子边界重新组装。
  //
  // 主规则是句末标点；但**自动生成的字幕(ASR)通常完全没有标点**，
  // 光靠标点会一路合并下去，所以必须有停顿和长度两道兜底。
  const PAUSE_GAP_SEC = 0.35; // 真实停顿（换气）的阈值
  const TARGET_CHARS = 90; // 无标点字幕按这个长度就近在字幕条边界切
  const HARD_CHARS = 260; // 绝对上限，防止极端情况合成一大段
  // 无标点轨道实在切不清楚时的兜底上限。纯规则判断不了"这句说完没有"，
  // 所以这里放宽一些，宁可长一点也别切在半截；真要按句意切得靠 AI 辅助。
  const HARD_CUES = 6;

  function joinCueText(a, b) {
    if (!a) return b || '';
    if (!b) return a;
    // 中日韩文字之间不加空格，其余用空格连接
    const needSpace = !/[　-鿿]$/.test(a) && !/^[　-鿿]/.test(b);
    return a + (needSpace ? ' ' : '') + b;
  }

  // 这条轨道到底有没有标点？
  // 注意要检测"文本里有没有标点"，不能检测"是不是以标点结尾" ——
  // 字幕条是按显示时长切的，句号绝大多数落在**条的中间**，
  // 按结尾判断会把有标点的轨道误判成无标点。
  function tracksHavePunctuation(entries) {
    const n = Math.min(60, entries.length);
    if (!n) return false;
    let hit = 0;
    for (let i = 0; i < n; i++) {
      const t = entries[i].original != null ? entries[i].original : entries[i].text || '';
      if (/[.!?。！？]/.test(t)) hit++;
    }
    return hit / n >= 0.15;
  }

  // 句末判定的两个常见误伤：缩写（Mr. Dr. etc.）和姓名缩写（J. K.）
  const ABBREV_TAIL = /(^|\s)(mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|fig|no|inc|ltd|co|dept|univ|approx|e\.g|i\.e)\.$/i;
  const INITIAL_TAIL = /(^|\s)[A-Z]\.$/;

  // 字幕条的 dur 会互相重叠（YouTube 滚动字幕的显示方式，实测相邻条重叠约 2.5 秒），
  // 直接用 start+dur 当结束时间的话，"停顿"永远算不出来。真实结束要跟下一条的开始取小。
  function effectiveEnd(e, next) {
    const raw = e.start + (e.dur || 0);
    return next ? Math.min(raw, next.start) : raw;
  }

  function cueText(e) {
    return e.original != null ? e.original : e.text || '';
  }

  // ---------- 把长句再切成"半句" ----------
  // 记笔记时整句往往太长（一句话经常横跨十几秒），用户要的是"点击时前面的一句或半句"。
  // 所以在句子基础上再按逗号一级的标点细分，太短的碎片并回相邻段。
  const CLAUSE_PUNCT = /[,;:，；：、]/;
  const SUBDIVIDE_OVER = 56; // 超过这个长度才考虑细分
  const MIN_SEGMENT = 22; // 细分后每段至少这么长，否则并回去

  function clauseCuts(text) {
    const cuts = [];
    for (let i = 0; i < text.length; i++) {
      if (!CLAUSE_PUNCT.test(text[i])) continue;
      let after = i + 1;
      // 英文逗号后面要有空格才算（避免切在 1,000 这种数字里）
      if (/[,;:]/.test(text[i])) {
        if (after < text.length && !/\s/.test(text[after])) continue;
        while (after < text.length && /\s/.test(text[after])) after++;
      }
      cuts.push(after);
    }
    return cuts;
  }

  // 中日韩为主的文本，同样意思占的字符数大约只有拉丁文字的一半
  function minLenFor(text) {
    const cjk = (text.match(/[　-鿿]/g) || []).length;
    return cjk / (text.length || 1) > 0.3 ? Math.round(MIN_SEGMENT * 0.45) : MIN_SEGMENT;
  }

  // 把一段文本按候选切点分成若干段，过短的并回前一段
  // 相邻切点之间超过 MAX_GAP_CHARS 时，塞进字幕条边界继续切。
  // 字幕条边界是 YouTube 自己的分段，基本落在词组边界上，比按字数硬截好得多 ——
  // 按字数截会切在单词中间，而且可能把要查的那个生词本身切掉。
  const MAX_GAP_CHARS = 160;

  // 字幕条边界不一定落在词边界上：YouTube 的 ASR 会把一个词拆到两条里
  // （intelligence → "in" + "telligence"）。在那儿切，笔记就会以半个词开头或结尾，
  // 实测存出来过 "rd about ..." 和 "... is in"。
  //
  // 上游 parseEvents 已经按 aAppend 把续条合回去了，正常不该再出现这种边界；
  // 这里是第二道闸 —— 判断依据只看字符本身，不依赖上游给的标记，
  // 所以哪怕 YouTube 换一种拆法也挡得住。
  function breaksWord(text, at) {
    if (at <= 0 || at >= text.length) return false;
    return /[A-Za-z0-9\u00C0-\u024F]/.test(text[at - 1]) && /[A-Za-z0-9\u00C0-\u024F]/.test(text[at]);
  }

  function fillLongGaps(cuts, cueBounds, textLen, text) {
    if (!cueBounds || !cueBounds.length) return cuts;
    const stops = cuts.slice().sort((a, b) => a - b).concat([textLen]);
    const out = [];
    let prev = 0;
    for (const stop of stops) {
      if (stop - prev > MAX_GAP_CHARS) {
        let last = prev;
        for (const b of cueBounds) {
          if (b <= last || b >= stop) continue;
          if (text && breaksWord(text, b)) continue; // 词中间不切
          // 拉开足够距离才切，免得切出一串碎片
          if (b - last >= MAX_GAP_CHARS * 0.6) {
            out.push(b);
            last = b;
          }
        }
      }
      if (stop < textLen) out.push(stop);
      prev = stop;
    }
    return out.sort((a, b) => a - b);
  }

  function splitWithMinLength(text, cuts, minLen) {
    const parts = [];
    let from = 0;
    for (const to of cuts.concat([text.length])) {
      const piece = text.slice(from, to);
      if (!piece.trim()) {
        from = to;
        continue;
      }
      const last = parts[parts.length - 1];
      // 自己太短，或者并进去之后剩下的尾巴会太短 —— 都并回上一段
      const restTooShort = text.length - to > 0 && text.length - to < minLen;
      if (last && (piece.trim().length < minLen || restTooShort)) {
        last.to = to;
        last.text = text.slice(last.from, to);
      } else {
        parts.push({ from, to, text: piece });
      }
      from = to;
    }
    return parts.map((p) => ({ from: p.from, to: p.to, text: p.text.trim() })).filter((p) => p.text);
  }

  // 对已经切好的句子再做一次细分。时间按字符比例摊到句子的时间区间上。
  function subdivideSentences(sentences) {
    const out = [];
    for (const s of sentences) {
      if (s.original.length <= SUBDIVIDE_OVER) {
        out.push(s);
        continue;
      }
      // 优先按逗号一级的标点切。
      //
      // 但光有逗号不够 —— 广播式字幕（带 >> 换人标记的那种）经常一大段完全没有
      // 句末标点，逗号又全挤在结尾。实测一段 554 字符的切点是
      // [470, 481, 494, 502, 509, 548]：第一段 470 字符里一个可切的地方都没有，
      // 切完还是一大坨。原来的字幕条兜底只在 `没有任何逗号` 时才启用，这种情况永远轮不到它。
      // 所以改成：只要相邻切点之间还是太长，就用字幕条边界继续补切。
      let cuts = clauseCuts(s.original);
      cuts = fillLongGaps(cuts, s.cueBounds, s.original.length, s.original);
      if (!cuts.length) {
        out.push(s);
        continue;
      }
      const parts = splitWithMinLength(s.original, cuts, MIN_SEGMENT);
      if (parts.length <= 1) {
        out.push(s);
        continue;
      }

      // 每一小段覆盖哪几条字幕，用 cueMarks 从字符位置换算出来。
      // 有了它，译文和时间戳都能按字幕条精确取，不用再按字符比例摊 ——
      // 比例法在原文和译文长度比例不均匀时会把译文整段错配，甚至让前面几段拿不到译文。
      const marks = s.cueMarks && s.cueMarks.length ? s.cueMarks : null;
      const tCues = s.targetCues && s.targetCues.length ? s.targetCues : null;

      // 没有 cueMarks 的（理论上不该出现，留个兜底）退回旧的比例法
      const tParts =
        !marks && s.target ? splitWithMinLength(s.target, clauseCuts(s.target), minLenFor(s.target)) : [];
      const span = s.end - s.start;
      const total = s.original.length || 1;

      parts.forEach((p, i) => {
        let target = '';
        let start = s.start + (p.from / total) * span;
        let end = s.start + (p.to / total) * span;
        let fromIndex = s.fromIndex;
        let toIndex = s.toIndex;

        if (marks) {
          // 覆盖区间 [p.from, p.to) 的字幕条：起点取最后一个 off <= p.from 的，
          // 终点取最后一个 off < p.to 的
          let a = marks[0];
          let b = marks[0];
          for (const m of marks) {
            if (m.off <= p.from) a = m;
            if (m.off < p.to) b = m;
          }
          fromIndex = a.index;
          toIndex = b.index;
          start = a.start;
          // 结束时间用下一段的起点，最后一段用整句的结尾
          const nextMark = marks.find((m) => m.off >= p.to);
          end = nextMark ? nextMark.start : s.end;
          if (tCues) {
            target = tCues
              .filter((t) => t.index >= fromIndex && t.index <= toIndex)
              .reduce((acc, t) => joinCueText(acc, t.text), '');
          }
        } else if (tParts.length === parts.length) {
          target = tParts[i].text;
        } else if (tParts.length) {
          const a = (p.from / total) * s.target.length;
          const b = (p.to / total) * s.target.length;
          const hit = tParts.filter((t) => (t.from + t.to) / 2 >= a && (t.from + t.to) / 2 < b);
          target = hit.map((t) => t.text).join('');
        }

        out.push({
          fromIndex,
          toIndex,
          start,
          end,
          original: p.text,
          target,
          approximate: s.approximate,
          partOf: s.original, // 保留所属整句，"往前多存"时要用
        });
      });
    }
    return out;
  }

  // entries: [{start, dur, original/text, target}]，返回句子数组，
  // 每个句子记录它覆盖了哪些字幕条（fromIndex..toIndex），方便回跳和高亮。
  function buildSentences(entries) {
    if (!entries || !entries.length) return [];
    const base = tracksHavePunctuation(entries) ? buildByPunctuation(entries) : buildByLength(entries);
    return subdivideSentences(base);
  }

  // 把所有字幕条拼成一条文本流，同时记下每条在流里占的区间
  function buildStream(entries, pick) {
    let text = '';
    const spans = [];
    for (let i = 0; i < entries.length; i++) {
      const t = pick(entries[i]) || '';
      if (text && t) {
        const needSpace = !/[　-鿿]$/.test(text) && !/^[　-鿿]/.test(t);
        if (needSpace) text += ' ';
      }
      const from = text.length;
      text += t;
      spans.push({ from, to: text.length, index: i });
    }
    return { text, spans };
  }

  // 在一段文本里找出所有句末位置
  function findSentenceCuts(text) {
    const cuts = [];
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (ch === '。' || ch === '！' || ch === '？') {
        cuts.push(k + 1);
        continue;
      }
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      // 吃掉连续的省略号/感叹号，并跳过右引号右括号
      let end = k;
      while (end + 1 < text.length && /[.!?]/.test(text[end + 1])) end++;
      let after = end + 1;
      while (after < text.length && /["'"』」）)\]]/.test(text[after])) after++;
      // 句末标点后面必须是空白或结尾，否则是小数点、网址之类
      if (after < text.length && !/\s/.test(text[after])) {
        k = end;
        continue;
      }
      const before = text.slice(Math.max(0, k - 12), k + 1);
      if (ABBREV_TAIL.test(before) || INITIAL_TAIL.test(before)) {
        k = end;
        continue;
      }
      cuts.push(after);
      k = end;
    }
    if (!cuts.length || cuts[cuts.length - 1] < text.length) cuts.push(text.length);
    return cuts;
  }

  function cutsToSegments(text, cuts) {
    const segs = [];
    let from = 0;
    for (const to of cuts) {
      const t = text.slice(from, to).trim();
      if (t) segs.push({ from, to, text: t, mid: (from + to) / 2 });
      from = to;
    }
    return segs;
  }

  // 有标点的轨道：在拼接后的文本流里按句末标点切，再映射回时间。
  // 这样才能处理"句号落在字幕条中间"的情况 —— 只在字幕条边界切的话，
  // 永远切不到真正的句子边界（实测 YouTube 的字幕绝大多数是这种）。
  function buildByPunctuation(entries) {
    const src = buildStream(entries, cueText);
    const tgt = buildStream(entries, (e) => e.target || '');
    const srcSegs = cutsToSegments(src.text, findSentenceCuts(src.text));

    return srcSegs.map((seg) => {
      const s = makeSentence(entries, src.spans, seg.from, seg.to, seg.text);
      s.target = targetForCueRange(tgt, s.fromIndex, s.toIndex);
      s.targetCues = targetCuesForRange(tgt, s.fromIndex, s.toIndex);
      return s;
    });
  }

  // 译文是按字幕条给的，一条字幕跨两个句子时切不开，
  // 所以不能按条拼（会重复或缺失）。改成：
  // 句子数一致就一一对应；不一致就按字符比例映射，再吸附到译文自己的句末边界。
  // 译文按**字幕条区间**取，不按字符比例换算。
  //
  // 原来的做法是 scale = 译文总长 / 原文总长，再按字符位置比例去译文流里截。
  // 它在两点上会崩：
  //   1) 原文和译文的句读密度可能完全不同 —— 机器翻译会补上原文根本没有的句号，
  //      于是译文段数远多于原文段数，一一对应失败，退化成按比例摊；
  //   2) 那个比例是**全片一个常数**。任何局部偏差都会往后累积，
  //      长播客里能漂出好几分钟 —— 实测存下来的例句译文讲的是视频里完全另一处的内容。
  //
  // 每条字幕的译文在 alignByTime 阶段已经按时间对齐过了，
  // 所以只要知道这一段覆盖哪几条字幕，直接取那几条的译文就是精确的。
  function targetForCueRange(tgt, fromIdx, toIdx) {
    if (!tgt.text) return '';
    let a = -1;
    let b = -1;
    for (const sp of tgt.spans) {
      if (sp.index < fromIdx || sp.index > toIdx) continue;
      if (sp.to <= sp.from) continue; // 这条没有译文
      if (a < 0) a = sp.from;
      b = sp.to;
    }
    return a < 0 ? '' : tgt.text.slice(a, b).trim();
  }

  // 逐条留一份译文。细分时按字幕条挑，比按字符比例摊准确得多。
  function targetCuesForRange(tgt, fromIdx, toIdx) {
    const out = [];
    if (!tgt.text) return out;
    for (const sp of tgt.spans) {
      if (sp.index < fromIdx || sp.index > toIdx) continue;
      const t = tgt.text.slice(sp.from, sp.to).trim();
      if (t) out.push({ index: sp.index, text: t });
    }
    return out;
  }

   // 把文本流区间 [from,to) 映射回时间和字幕条下标
  function makeSentence(entries, spans, from, to, text) {
    let firstIdx = -1;
    let lastIdx = 0;
    for (const s of spans) {
      if (s.to > from && s.from < to) {
        if (firstIdx < 0 || s.index < firstIdx) firstIdx = s.index;
        if (s.index > lastIdx) lastIdx = s.index;
      }
    }
    if (firstIdx < 0) firstIdx = lastIdx;

    // 记下每条字幕在这段文本里的起始偏移。没有逗号可切的长句，
    // 就退而求其次在字幕条边界上切 —— 那是 YouTube 自己的分段，大体落在词组边界。
    const raw = text.length !== to - from ? to - from - text.length : 0; // trim 掉的前导空白
    const cueBounds = [];
    // cueMarks 比 cueBounds 多带一个字幕条下标，细分时靠它把每一小段对应回具体几条字幕，
    // 从而精确取到那几条的译文，而不是按字符比例去猜。
    const cueMarks = [{ off: 0, index: firstIdx, start: entries[firstIdx].start }];
    for (const s of spans) {
      if (s.index <= firstIdx || s.index > lastIdx) continue;
      const off = s.from - from + raw;
      if (off > 0 && off < text.length) {
        cueBounds.push(off);
        cueMarks.push({ off, index: s.index, start: entries[s.index].start });
      }
    }

    const firstEntry = entries[firstIdx];
    const lastEntry = entries[lastIdx];
    return {
      fromIndex: firstIdx,
      toIndex: lastIdx,
      start: firstEntry.start,
      end: effectiveEnd(lastEntry, entries[lastIdx + 1]),
      original: text,
      target: '',
      approximate: false,
      cueBounds,
      cueMarks,
    };
  }

  // 完全没有标点的轨道（老式 ASR，实测标点率 0%）：
  // 只能靠停顿和长度在字幕条边界近似切分，切出来的不是真正的句子。
  function buildByLength(entries) {
    const sentences = [];
    let cur = null;
    const flush = () => {
      if (cur) sentences.push(cur);
      cur = null;
    };

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const next = entries[i + 1];
      const text = cueText(e);
      const end = effectiveEnd(e, next);

      if (!cur) {
        cur = {
          fromIndex: i,
          toIndex: i,
          start: e.start,
          end,
          original: text,
          target: e.target || '',
          approximate: true,
          cueBounds: [],
          cueMarks: [{ off: 0, index: i, start: e.start }],
          targetCues: e.target ? [{ index: i, text: e.target }] : [],
        };
      } else {
        cur.toIndex = i;
        cur.end = end;
        // 记下这条字幕在合并后文本里的起始位置 —— 细分时要靠它对应回具体是哪几条
        cur.original = joinCueText(cur.original, text);
        const off = cur.original.length - text.length;
        if (text && off > 0 && off < cur.original.length) {
          cur.cueBounds.push(off);
          cur.cueMarks.push({ off, index: i, start: e.start });
        }
        cur.target = joinCueText(cur.target, e.target || '');
        if (e.target) cur.targetCues.push({ index: i, text: e.target });
      }

      const cueCount = cur.toIndex - cur.fromIndex + 1;
      let shouldBreak = false;
      if (!next) shouldBreak = true;
      else if (next.start - cur.end >= PAUSE_GAP_SEC) shouldBreak = true;
      else if (cur.original.length >= HARD_CHARS || cueCount >= HARD_CUES) shouldBreak = true;
      else if (cur.original.length >= TARGET_CHARS) shouldBreak = true;

      if (shouldBreak) flush();
    }
    flush();
    return sentences;
  }

  // 找出某个时间点落在哪一句。
  // justEnteredSec：如果刚进入这句还不到这么久，就认为用户想存的是**上一句** ——
  // 人听到一句好的、反应过来再按键，通常已经过去一两秒了。
  function findSentenceAt(sentences, time, justEnteredSec) {
    if (!sentences || !sentences.length) return -1;
    let idx = -1;
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].start <= time) idx = i;
      else break;
    }
    if (idx < 0) return 0;
    const grace = typeof justEnteredSec === 'number' ? justEnteredSec : 1.5;
    if (idx > 0 && time - sentences[idx].start < grace) return idx - 1;
    return idx;
  }

  // ---------- 文本转义 / 小工具 ----------
  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- 生词高亮 ----------
  // 存的是"要高亮哪几个词/词组"这样一组字符串，不是字符下标。
  // 下标写起来更精确，但句子文本一旦变过（比如以后补了标点清洗）就全错位，
  // 而按词匹配永远指向对的东西，还能顺带把句子里重复出现的同一个词一起标出来。
  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildHighlightRe(terms) {
    const list = (terms || [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      // 长的排前面：词组和它内部的单词都被高亮时，正则的选择分支取先匹配上的那个，
      // 不排序的话 "take off" 会被里面的 "take" 抢先切断
      .sort((a, b) => b.length - a.length);
    if (!list.length) return null;
    const parts = list.map((t) => {
      const body = escapeRe(t);
      // 纯 ASCII 词才加词边界 —— 否则 "on" 会在 "onto" 里面命中。
      // 中日韩没有词边界的概念，\b 在那里会乱来，所以按原样匹配。
      return /^[A-Za-z0-9'’\- ]+$/.test(t) ? '\\b' + body + '\\b' : body;
    });
    try {
      return new RegExp('(' + parts.join('|') + ')', 'gi');
    } catch (e) {
      return null;
    }
  }

  // 找出所有命中区间。拿到区间之后再决定包 <mark> 还是包 **，
  // 两种输出共用同一套匹配，不会出现界面高亮了、导出没高亮的情况。
  function highlightRanges(text, terms) {
    const re = buildHighlightRe(terms);
    if (!re) return [];
    const out = [];
    let m;
    while ((m = re.exec(String(text)))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }

  // 注意顺序：先按原文切片，再对每一片转义。
  // 反过来做（先转义整句再往里塞标签）会让 &amp; 这类实体被当成普通字符匹配到。
  function highlightHtml(text, terms) {
    const s = String(text || '');
    const ranges = highlightRanges(s, terms);
    if (!ranges.length) return escapeHtml(s);
    let out = '';
    let at = 0;
    ranges.forEach(([a, b]) => {
      out += escapeHtml(s.slice(at, a)) + '<mark class="ytlb-hl">' + escapeHtml(s.slice(a, b)) + '</mark>';
      at = b;
    });
    return out + escapeHtml(s.slice(at));
  }

  // 用 ==词== 而不是 **词**。
  // Markdown 本身没有高亮语法，== 是通行的扩展写法，Obsidian / Typora 直接渲染成荧光笔；
  // ** 是"加粗"，语义上是另一回事，而且笔记里本来就有别的地方在用加粗。
  // 不支持 == 的编辑器里会原样显示 ==词==，仍然一眼能看出这里被标过。
  // 真正想要"看起来就是高亮"的，用 HTML 导出。
  function highlightMd(text, terms) {
    const s = String(text || '');
    const ranges = highlightRanges(s, terms);
    if (!ranges.length) return s;
    let out = '';
    let at = 0;
    ranges.forEach(([a, b]) => {
      out += s.slice(at, a) + '==' + s.slice(a, b) + '==';
      at = b;
    });
    return out + s.slice(at);
  }

  // 加一个词就切换一次状态：已经高亮的再按一次取消。
  // 返回 null 表示这个词不该被接受（空白、或者长得离谱的整段选择）。
  function toggleHighlight(list, term) {
    const t = String(term || '').trim();
    if (!t || t.length > 60) return null;
    const cur = (list || []).slice();
    const i = cur.findIndex((x) => String(x).toLowerCase() === t.toLowerCase());
    if (i >= 0) {
      cur.splice(i, 1);
      return { list: cur, added: false, term: t };
    }
    cur.push(t);
    return { list: cur, added: true, term: t };
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  Object.assign(YTLB, {
    DEFAULT_SETTINGS,
    LANG_NAMES,
    getSettings,
    saveSettings,
    getEntries,
    saveEntries,
    getVocab,
    saveVocab,
    uid,
    normalizeLang,
    candidateTargetLangs,
    cleanFillerWords,
    buildSentences,
    findSentenceAt,
    escapeHtml,
    highlightHtml,
    highlightMd,
    toggleHighlight,
    formatTime,
  });

  root.YTLB = YTLB;
})(typeof window !== 'undefined' ? window : globalThis);
