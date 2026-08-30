// sidepanel.js
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const T = (k, v) => YTI18N.t(k, v);

  // 语言名要跟着界面语言走：界面是英文时不该显示"英语→中文"
  const LANG_KEY = { zh: 'set.langZh', en: 'set.langEn', fr: 'set.langFr' };
  function langName(code) {
    return LANG_KEY[code] ? T(LANG_KEY[code]) : code || T('st.unknownLang');
  }

  // 字幕轨道可能是任何语言（阿拉伯语、缅甸语、希伯来语…），
  // 上面那个只认中英法三种，其余会原样显示成 'ar' 'my' 'iw' 这种代码。
  // Intl.DisplayNames 是浏览器内置的，不用带任何语言数据表。
  function trackLangName(code) {
    if (!code) return T('st.unknownLang');
    if (LANG_KEY[code]) return T(LANG_KEY[code]);
    try {
      const dn = new Intl.DisplayNames([YTI18N.getLang() === 'zh' ? 'zh' : 'en'], { type: 'language' });
      return dn.of(code) || code;
    } catch (e) {
      return code;
    }
  }
  // 用量统计里的功能名：后台存的是稳定的键，显示时才翻译，
  // 这样切换界面语言不会让历史记录变成两种语言混在一起
  const FEAT_KEY = {
    transAll: 'feat.transAll',
    explain: 'feat.explain',
    deepExplain: 'feat.deepExplain',
    gloss: 'feat.gloss',
    outline: 'feat.outline',
    // 旧版本存的是中文功能名（那时还没抽 key），历史记录里仍是这些字符串。
    // 不映射的话，英文界面下这几行会突然冒出中文。
    整篇翻译: 'feat.transAll',
    点词解释: 'feat.explain',
    悬停速查: 'feat.gloss',
    悬停取词: 'feat.gloss',
    内容概括: 'feat.outline',
    大纲概述: 'feat.outline',
    断句辅助: null, // 这个功能已不单独计入，旧记录直接不显示
    保存笔记: null,
  };
  function featName(key) {
    const mapped = FEAT_KEY[key];
    return mapped ? T(mapped) : key;
  }
  function featHidden(key) {
    return Object.prototype.hasOwnProperty.call(FEAT_KEY, key) && FEAT_KEY[key] === null;
  }

  const S = {
    trackedTabId: null,
    trackedVideoId: null,
    settings: null,
    lastState: null,
    lastTranscript: null,
    lastRenderSig: null, // 用来判断字幕列表是否需要重建 DOM
    followPlayback: true,
    hoverGloss: true,
  };

  // 最后一次"用户自己在操作"的时间。自动滚动会在这之后让开几秒，
  // 免得把用户正在点的控件滚出视野。
  let userScrolledAt = 0;

  // ---------------- 分段控件 ----------------
  // 二三选一用它比下拉框好：当前状态不用点开就能看见，360px 窄栏里也更省地方。
  function segValue(el) {
    const on = el.querySelector('button.on');
    return on ? on.dataset.value : '';
  }
  function segSet(el, value) {
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === value));
  }
  function segDisabled(el, flag) {
    el.querySelectorAll('button').forEach((b) => (b.disabled = flag));
  }
  function segOnChange(el, fn) {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !el.contains(b) || b.disabled) return;
      if (b.classList.contains('on')) return; // 点的是已选中的那个，什么都不做
      segSet(el, b.dataset.value);
      fn(b.dataset.value);
    });
  }

  // ---------------- Tab bar ----------------
  // 设置不在标签栏里（用得少，不值得常占一格），走标题右边的齿轮按钮。
  let lastContentTab = 'learn';
  function switchTab(name) {
    if (name !== 'settings') lastContentTab = name;
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
    $('#btn-settings').classList.toggle('active', name === 'settings');
    if (name === 'notes') renderNotes();
    if (name === 'vocab') renderVocab();
    if (name === 'learn') renderTranscriptList();
    if (name === 'settings') renderUsage();
  }
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 齿轮是开关：设置开着就点回上一个内容页
  $('#btn-settings').addEventListener('click', () => {
    const onSettings = $('#panel-settings').classList.contains('active');
    switchTab(onSettings ? lastContentTab : 'settings');
  });

  // ---------------- Tab tracking ----------------
  async function getTrackedTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (t && t.url && /^https:\/\/www\.youtube\.com\/watch/.test(t.url)) {
          resolve(t);
        } else {
          resolve(null);
        }
      });
    });
  }

  function sendToTab(type, extra) {
    return new Promise((resolve) => {
      if (!S.trackedTabId) return resolve({ ok: false, error: T('st.openOnYoutube') });
      chrome.tabs.sendMessage(S.trackedTabId, Object.assign({ type }, extra || {}), (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: T('st.tabFail', { reason: chrome.runtime.lastError.message }) });
          return;
        }
        resolve(resp || { ok: false, error: T('st.noResponse') });
      });
    });
  }

  async function refreshTrackedTab() {
    const tab = await getTrackedTab();
    S.trackedTabId = tab ? tab.id : null;
    await refreshBanner();
  }

  chrome.tabs.onActivated.addListener(refreshTrackedTab);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') refreshTrackedTab();
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'YTLB_SENTENCE_CHANGED' && sender.tab && sender.tab.id === S.trackedTabId) {
      // 必须把最新下标同步进 S.lastState。
      // 之前只更新了卡片显示，而 S.lastState 要等下一次 refreshBanner（切标签页/页面加载完成）
      // 才刷新 —— 于是卡片上显示的是第 300 句，lastState.currentIndex 还停在几分钟前的第 40 句。
      // 所有"对当前句做点什么"的操作都会挂到那个陈旧的句子上：
      // 翻译当前句、保存笔记、划选解释、划选+V 存生词，全都错位。
      if (S.lastState) {
        S.lastState.currentIndex = msg.payload.index;
        S.lastState.currentEntry = msg.payload.entry;
      }
      updateCurrentCard(msg.payload.entry);
      highlightCurrentLine(msg.payload.index, msg.payload.playing);
    }
  });

  // ---------------- Banner + 当前句卡片 ----------------
  async function refreshBanner() {
    if (!S.trackedTabId) {
      $('#video-title').textContent = T('top.noVideo');
      $('#video-meta').textContent = T('top.openVideo');
      $('#current-original').textContent = T('learn.placeholder');
      $('#current-target').textContent = '';
      return;
    }
    const st = await sendToTab('YTLB_GET_STATE');
    if (!st || !st.videoId) {
      $('#video-title').textContent = T('top.noCaptions');
      $('#video-meta').textContent = '';
      return;
    }
    S.lastState = st;
    if (st.videoId !== S.trackedVideoId) {
      S.trackedVideoId = st.videoId;
      S.lastTranscript = null;
      S.lastRenderSig = null;
    }
    $('#video-title').textContent = st.videoTitle || '';

    // 字幕拿不到时要说清楚是哪一种情况，不能静默失败
    if (st.failReason) {
      const tip = {
        'no-captions': T('st.failNoCaptions'),
        'no-access': T('st.failNoAccess'),
        'empty-transcript': T('st.failEmpty'),
      }[st.failReason] || T('st.failGeneric');
      $('#video-meta').textContent = tip;
      $('#current-original').textContent = tip;
      $('#current-target').textContent = '';
      return;
    }
    if (st.loading && !st.transcriptLength) {
      $('#video-meta').textContent = T('st.loading');
      return;
    }
    const srcName = langName(st.sourceLang);
    const tgtName = langName(st.targetLang);
    $('#video-meta').textContent = T('st.meta', { src: srcName, tgt: tgtName, n: st.transcriptLength });
    populateSourceLangSelect(st);
    populateTargetLangSelect(st.sourceLang, st.targetLang);
    updateCurrentCard(st.currentEntry);
    // 兜底：广播消息偶尔会漏，靠这里保证高亮和自动滚动不会卡住
    if (typeof st.currentIndex === 'number' && st.currentIndex >= 0) highlightCurrentLine(st.currentIndex, st.playing);
    if ($('#panel-learn').classList.contains('active')) renderTranscriptList();
  }

  // 原文轨道选择器。
  // 自动识别只有三条依据（defaultAudioLanguage → ASR 轨道语言 → 独苗轨道），
  // 多语言字幕的视频三条可能全落空，只能取列表第一条，而那个顺序和音频语言无关。
  // 所以给一个显式出口，而不是让人对着错的原文干瞪眼。
  function populateSourceLangSelect(st) {
    const sel = $('#source-lang-select');
    const tracks = (st && st.tracks) || [];
    // 只有一条轨道时没得选，整行藏起来省地方
    const row = sel.closest('.tool-row');
    if (tracks.length < 2) {
      if (row) row.style.display = 'none';
      return;
    }
    if (row) row.style.display = '';

    // 同一语言可能有人工和自动两条，按语言去重
    const seen = new Set();
    const langs = [];
    tracks.forEach((t) => {
      const code = YTLB.normalizeLang(t.languageCode);
      if (!code || seen.has(code)) return;
      seen.add(code);
      langs.push({ code, raw: t.languageCode });
    });

    const autoLabel = st.forcedSourceLang
      ? T('learn.sourceAutoUnknown')
      : T('learn.sourceAuto', { lang: trackLangName(st.sourceLang) });
    const sig = 'auto|' + langs.map((l) => l.code).join(',') + '|' + autoLabel;
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML =
        `<option value="">${YTLB.escapeHtml(autoLabel)}</option>` +
        langs
          .map((l) => `<option value="${YTLB.escapeHtml(l.code)}">${YTLB.escapeHtml(trackLangName(l.code))}</option>`)
          .join('');
    }
    sel.value = st.forcedSourceLang || '';
  }

  $('#source-lang-select').addEventListener('change', async (e) => {
    const sel = e.target;
    const lang = sel.value;
    sel.disabled = true;
    $('#video-meta').textContent = T('st.switchingLang');
    await sendToTab('YTLB_SET_SOURCE_LANG', { lang });
    sel.disabled = false;
    await refreshBanner();
    // 换了原文轨道等于整份字幕都换了，列表必须重建
    S.lastRenderSig = null;
    S.lastTranscript = null;
    renderTranscriptList();
  });

  // 目标语言候选**排除和原文相同的那个** —— 把字幕翻译成它自己没有意义。
  // 设置页那个下拉有三种语言，这里只有两种，两边写的是同一个设置：
  // 在设置里选了和原文一样的语言，字幕会静默回退到候选里的第一个。
  // 试过让两边一致（相同就不翻译、只显示原文），但"只看译文"视图会变成空白，退回来了。
  function populateTargetLangSelect(sourceLang, currentTarget) {
    const sel = $('#target-lang-select');
    const candidates = YTLB.candidateTargetLangs(sourceLang);
    const want = currentTarget || candidates[0];
    // 候选没变就别重建，否则每次刷新都会把按钮重新生成一遍
    const existing = Array.from(sel.querySelectorAll('button')).map((b) => b.dataset.value);
    if (existing.join(',') !== candidates.join(',')) {
      sel.innerHTML = candidates
        .map((c) => `<button type="button" data-value="${c}">${YTLB.escapeHtml(langName(c))}</button>`)
        .join('');
    }
    segSet(sel, want);
  }



  // 正在操作这两个控件时先别自动滚动。切换语言要重新拉字幕、重渲染列表，
  // 期间任何一次自动滚动都会把控件本身滚出视野，让人没法继续点。
  ['mousedown', 'click'].forEach((ev) => {
    $('#target-lang-select').addEventListener(ev, () => {
      userScrolledAt = Date.now();
    });
  });

  segOnChange($('#target-lang-select'), async (lang) => {
    const sel = $('#target-lang-select');
    segDisabled(sel, true);
    $('#video-meta').textContent = T('st.switchingLang');
    await sendToTab('YTLB_SET_TARGET_LANG', { lang });
    segDisabled(sel, false);
    await refreshBanner();
    // 换了目标语言，整份字幕的译文都变了，列表必须重渲染 ——
    // 少了这一步就得关掉面板再打开才看得到新译文
    S.lastTranscript = null;
    S.lastRenderSig = null;
    await renderTranscriptList();
  });

  function updateCurrentCard(entry) {
    if (!entry) return;
    $('#current-original').textContent = entry.original;
    $('#current-target').textContent = entry.target || '';
    $('#current-save-hint').textContent = '';
    // 已经有译文时「翻译」没有意义 —— 它只会走一遍保存流程，
    // 看起来就变成了一个"保存"按钮，容易让人以为点错了。
    $('#btn-translate-current').style.display = entry.target ? 'none' : '';
  }

  $('#btn-translate-current').addEventListener('click', async () => {
    if (!S.lastState || !S.lastState.currentEntry) return;
    $('#current-save-hint').textContent = T('st.translating');
    const res = await sendToTab('YTLB_TRANSLATE_AND_SAVE', { index: S.lastState.currentIndex });
    if (res.ok) {
      $('#current-target').textContent = res.target || T('st.lineFail');
      // 只有真的存进去了才说存了 —— 关掉"自动保存"开关时后端不会保存，
      // 原来这里无条件显示"已自动保存"，等于在骗人。
      $('#current-save-hint').textContent = res.entry ? T('st.savedToNotes') : '';
    } else {
      $('#current-save-hint').textContent = T('st.failPrefix', { reason: res.error || T('st.unknownError') });
    }
  });

  // 点按钮的那一下（mousedown）就会把选区清掉，等 click 触发时 getSelection() 已经是空的 ——
  // 所以必须在选区还在的时候先记下来。
  // 连当时的句子下标也要一起记：从划选到点按钮往往过了几秒，视频还在播，
  // 等点下去时 currentIndex 已经跑到后面的句子了，解释就会挂到错误的句子上。
  //
  // 下标不能一律取"正在播的那一句"：在字幕列表里往回翻着划选时，
  // 你选的那行和正在播的根本不是一句，解释会挂到别处去。
  // 交给 selectionContext() 判断 —— 列表里的行用行自己的下标，
  // 「当前句」卡片才用播放位置。
  let lastSelection = '';
  let lastSelectionIndex = -1;
  document.addEventListener('selectionchange', () => {
    const ctx = selectionContext();
    if (!ctx) return; // 空选区、或者选在笔记/生词/设置里，都不覆盖上一次的记录
    lastSelection = ctx.text;
    lastSelectionIndex = ctx.index;
  });

  // ---------- 生词高亮 ----------
  // 卡片里要标出来的词 = 这条记录本来就"关于"的那个词 + 用户后来手动加的。
  // 前者是推导出来的，不占存储：生词条目的 word、笔记条目的 explainedWord
  // 本来就存着，没必要再复制一份进 highlights。
  function hlTerms(item) {
    const auto = item.word || item.explainedWord || '';
    return (auto ? [auto] : []).concat(item.highlights || []);
  }

  // ---------- 编辑已保存的原文 / 译文 ----------
  // 断句是规则算出来的，再准也有切多切少的时候，得留一个人工兜底。
  //
  // 原文和译文分两个框、各改各的 —— 不做"删了原文译文自动跟着删"，因为做不对：
  // 英译法时语序会变，删掉英文的前半句，对应的法文可能在句尾。
  // 按字符位置比例去截译文，结果时对时错，那比不动更糟。
  // 想省事就点「重新翻译（AI）」，一句话约 ¥0.0002。
  function openCardEditor(card, isVocab, item) {
    if (card.querySelector('.card-editor')) return; // 已经在编辑了
    const origText = isVocab ? item.sentenceOriginal || '' : item.original || '';
    const transText = isVocab ? item.sentenceTranslation || '' : item.translation || '';

    const box = document.createElement('div');
    box.className = 'card-editor';
    box.innerHTML = `
      <label class="ed-label">${T('notes.editOrig')}</label>
      <textarea class="ed-orig"></textarea>
      <label class="ed-label">${T('notes.editTrans')}</label>
      <textarea class="ed-trans"></textarea>
      <div class="ed-actions">
        <button class="ed-save">${T('notes.editSave')}</button>
        <button class="ed-cancel">${T('exp.cancel')}</button>
        <button class="ed-retrans">${T('notes.retranslate')}</button>
        <span class="ed-hint hint"></span>
      </div>`;
    box.querySelector('.ed-orig').value = origText;
    box.querySelector('.ed-trans').value = transText;
    card.appendChild(box);
    // 编辑器是插在卡片**底部**的，将近 190px 高。笔记多的时候被点的那张卡片
    // 往往靠近视口下缘，编辑器就整个落在折线以下 —— 表现是"点了完全没反应"。
    // 必须主动滚进来。
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    box.querySelector('.ed-orig').focus();

    box.querySelector('.ed-cancel').addEventListener('click', () => box.remove());

    box.querySelector('.ed-retrans').addEventListener('click', async () => {
      const src = box.querySelector('.ed-orig').value.trim();
      const hint = box.querySelector('.ed-hint');
      if (!src) return;
      const st = S.settings || (await YTLB.getSettings());
      if (!st.apiKey) {
        hint.textContent = T('st.noApiKeyLong');
        return;
      }
      hint.textContent = T('st.lineTranslating');
      const r = await chrome.runtime.sendMessage({
        type: 'YTLB_AI_TRANSLATE_BATCH',
        payload: {
          apiKey: st.apiKey,
          baseUrl: st.baseUrl,
          model: st.translateModel,
          lines: [src],
          targetLang: item.targetLang || st.targetLang,
          sourceLang: item.sourceLang,
        },
      });
      if (r && r.ok && r.translations && r.translations[0]) {
        box.querySelector('.ed-trans').value = r.translations[0];
        hint.textContent = '';
      } else {
        // 只提示，不动已有译文 —— 翻译失败不该顺手把用户手写的内容清掉
        hint.textContent = T('notes.retransFail');
      }
    });

    box.querySelector('.ed-save').addEventListener('click', async () => {
      const o = box.querySelector('.ed-orig').value.trim();
      const t = box.querySelector('.ed-trans').value.trim();
      const all = isVocab ? await YTLB.getVocab() : await YTLB.getEntries();
      const i = all.findIndex((x) => x.id === item.id);
      if (i < 0) return;
      if (isVocab) {
        all[i].sentenceOriginal = o;
        all[i].sentenceTranslation = t;
        await YTLB.saveVocab(all);
        await renderVocab();
      } else {
        all[i].original = o;
        all[i].translation = t;
        await YTLB.saveEntries(all);
        await renderNotes();
      }
      flashListHint(T('notes.saved'));
    });
  }

  // 高亮的反馈借用列表顶部那行计数文字，一两秒后自己变回去。
  // 卡片本身刚被重绘过，往卡片上贴提示会闪一下就没，反而看不清。
  function flashListHint(text) {
    const el = $('#panel-vocab').classList.contains('active') ? $('#vocab-count') : $('#notes-count');
    const prev = el.textContent;
    el.textContent = text;
    setTimeout(() => {
      if (el.textContent === text) el.textContent = prev;
    }, 1800);
  }

  // 划选 + H：给已保存的卡片加/去高亮。再按一次同一个词就是取消。
  // 只认落在笔记/生词卡片里的选区 —— 在字幕页划选按 H 不该有反应。
  async function toggleCardHighlight() {
    const s = window.getSelection();
    const text = s ? s.toString().trim() : '';
    if (!text) return null;
    let node = s.anchorNode;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || !node.closest) return null;
    const card = node.closest('.note-item, .vocab-item');
    if (!card) return null;

    const isVocab = card.classList.contains('vocab-item');
    const all = isVocab ? await YTLB.getVocab() : await YTLB.getEntries();
    const i = all.findIndex((x) => x.id === card.dataset.id);
    if (i < 0) return null;

    const r = YTLB.toggleHighlight(all[i].highlights || [], text);
    if (!r) return null; // 空白或选了一大段，不接受
    all[i].highlights = r.list;
    if (isVocab) await YTLB.saveVocab(all);
    else await YTLB.saveEntries(all);
    if (isVocab) await renderVocab();
    else await renderNotes();
    return r;
  }

  // 判断选区落在哪里，以及这段文字该挂到哪一句上。
  // 「当前句」卡片用正在播的那一句；字幕列表里的行直接用行自己的下标 ——
  // 在列表里往回翻着选词时，正在播的句子和你选的那行根本不是一句。
  function selectionContext() {
    const s = window.getSelection();
    const text = s ? s.toString().trim() : '';
    if (!text) return null;
    let node = s.anchorNode;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || !node.closest) return null;
    if (node.closest('#current-original')) {
      const i = S.lastState && S.lastState.currentIndex >= 0 ? S.lastState.currentIndex : -1;
      return { text, index: i };
    }
    const line = node.closest('[data-index]');
    if (line) {
      const i = parseInt(line.dataset.index, 10);
      if (!isNaN(i)) return { text, index: i };
    }
    return null;
  }

  // 快捷键 V：把划选的词/词组直接存进生词本，不调用任何 API。
  //
  // 为什么放在侧边栏而不是视频浮层：浮层上的词挂着悬停取词，鼠标停上去 350ms
  // 就已经发出查词请求了 —— 想"不查词只收藏"在那里做不到。而"当前句"这张卡片
  // 是纯文本，没有悬停也没有点击处理，划选它不产生任何调用。
  // 顺带的好处是划选能选词组，悬停只能选单个词。
  document.addEventListener('keydown', async (e) => {
    // 笔记输入框就在这张卡片下面，不挡住的话打字打个 v 就存生词了
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

    // N / R：焦点在侧边栏时，页面里的监听器收不到按键 —— 侧边栏是独立文档。
    // 这曾经表现为"偶尔按 N 没反应"：点过时间戳或滚过字幕列表之后焦点就在这边了，
    // 于是键被吞掉，连失败提示都没有。转发到内容脚本，走和页面上完全同一条路。
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      await sendToTab('YTLB_SAVE_HOTKEY');
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      await sendToTab('YTLB_REPLAY_SENTENCE');
      return;
    }

    // H：给笔记/生词卡片里划选的词加或去高亮
    if (e.key === 'h' || e.key === 'H') {
      const r = await toggleCardHighlight();
      if (!r) return;
      e.preventDefault();
      flashListHint(T(r.added ? 'notes.highlighted' : 'notes.hlRemoved', { word: r.term }));
      return;
    }

    if (e.key !== 'v' && e.key !== 'V') return;

    // 这里读**实时**选区，不用 lastSelection ——
    // lastSelection 是为"点按钮会清掉选区"准备的，按键不会清选区。
    // 用它反而会有陈旧值：十分钟前在笔记页选的东西，现在按 V 会被当成生词存进去。
    const ctx = selectionContext();
    const hint = $('#current-save-hint');
    if (!ctx) {
      // 选区在笔记/生词/设置这些地方时静默忽略，不该弹生词相关的提示
      const s = window.getSelection();
      const active = $('#panel-learn').classList.contains('active');
      if (active && !(s && s.toString().trim())) hint.textContent = T('st.selectFirst');
      return;
    }
    if (ctx.index < 0) {
      hint.textContent = T('st.noCurrent');
      return;
    }
    e.preventDefault();
    const r = await sendToTab('YTLB_QUICK_ADD_VOCAB', { payload: { word: ctx.text, index: ctx.index } });
    if (!r || !r.ok) {
      hint.textContent = T('st.failPrefix', { reason: (r && r.error) || T('st.unknownError') });
      return;
    }
    hint.textContent = T(r.dup ? 'ov.vocabDup' : 'ov.vocabAdded', { word: r.word });
    if (!r.dup) renderVocab();
  });

  // idx 是这个词所属的句子下标，收藏生词时要用它取来源例句。
  // 之前这张卡片上没有「＋生词」—— 字幕行里展开的解释有，视频浮层上的解释也有，
  // 唯独「词组解释」按钮弹出的这张没有，等于划选出来的词组没法收藏。
  function showExplain(word, explanation, idx) {
    const box = $('#explain-box');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="explain-word">${YTLB.escapeHtml(word)}</div>
      <div class="explain-text">${YTLB.escapeHtml(explanation)}</div>
      <div class="explain-actions">
        <button class="explain-save">${T('learn.addVocab')}</button>
        <button class="explain-copy">${T('learn.copy')}</button>
        <button class="explain-close">${T('learn.close')}</button>
      </div>`;
    box.querySelector('.explain-save').addEventListener('click', async (e) => {
      // 走 QUICK_ADD 而不是 ADD_VOCAB，是为了带上查重 —— 这张卡片会停留在屏幕上，
      // 很容易被点第二次。解释直接当第三个参数传进去，不用再发一条消息。
      const r = await sendToTab('YTLB_QUICK_ADD_VOCAB', { payload: { word, index: idx, explanation } });
      e.target.textContent = T(r && r.dup ? 'ov.vocabDup' : 'learn.addedVocab', { word: (r && r.word) || word });
      e.target.disabled = true;
      renderVocab();
    });
    box.querySelector('.explain-copy').addEventListener('click', (e) => {
      navigator.clipboard.writeText(`${word}：${explanation}`);
      e.target.textContent = T('learn.copied');
      setTimeout(() => (e.target.textContent = T('learn.copy')), 1500);
    });
    box.querySelector('.explain-close').addEventListener('click', () => {
      box.classList.add('hidden');
      box.innerHTML = '';
    });
  }

  $('#btn-explain-current').addEventListener('click', async () => {
    const sel = lastSelection;
    const idx = lastSelectionIndex;
    if (!sel) {
      $('#current-save-hint').textContent = T('st.selectFirst');
      return;
    }
    if (idx < 0) {
      $('#current-save-hint').textContent = T('st.noCurrent');
      return;
    }
    $('#current-save-hint').textContent = T('st.explaining', { word: sel });
    const res = await sendToTab('YTLB_EXPLAIN_WORD', { index: idx, word: sel });
    $('#current-save-hint').textContent = '';
    if (res && res.ok) {
      showExplain(sel, res.explanation, idx);
    } else {
      $('#current-save-hint').textContent = T('st.failPrefix', { reason: (res && res.error) || T('st.unknownError') });
    }
  });

  $('#btn-replay-current').addEventListener('click', async () => {
    // 交给内容脚本按整句回跳，它那边才有句子索引
    await sendToTab('YTLB_REPLAY_SENTENCE');
  });

  $('#btn-save-current').addEventListener('click', async () => {
    if (!S.lastState) return;
    const note = $('#current-note').value.trim();
    const res = await sendToTab('YTLB_SAVE_MANUAL', { index: S.lastState.currentIndex, note });
    $('#current-save-hint').textContent = res.ok ? T('st.savedToNotes') : T('st.failPrefix', { reason: res.error || '' });
    if (res.ok) $('#current-note').value = '';
  });

  // ---------------- 字幕全文列表 ----------------
  function wrapWordsHtml(text) {
    return text
      .split(/(\s+)/)
      .map((tok) => (tok.trim() ? `<span class="ytlb-word">${YTLB.escapeHtml(tok)}</span>` : YTLB.escapeHtml(tok)))
      .join('');
  }

  // 侧边栏里的悬停速查：只出一个最短词义，点击才走完整解释。
  // 缓存和模型档位都在内容脚本那边统一管，这里只负责显示。
  let panelGlossEl = null;
  let panelGlossTimer = null;
  let panelGlossHideTimer = null;
  // 和浮层那边同样的问题：原来用自增序号判断结果是否有效，
  // 但请求要一秒才回来，鼠标一动结果就被丢掉了。改成记住"现在停在哪个词上"。
  let panelHoverEl = null;

  function hidePanelGloss() {
    if (panelGlossTimer) {
      clearTimeout(panelGlossTimer);
      panelGlossTimer = null;
    }
    panelHoverEl = null;
    if (panelGlossEl) panelGlossEl.style.display = 'none';
  }

  function showPanelGloss(text, el) {
    if (!panelGlossEl) {
      panelGlossEl = document.createElement('div');
      panelGlossEl.id = 'panel-gloss-tip';
      document.body.appendChild(panelGlossEl);
    }
    panelGlossEl.textContent = text;
    panelGlossEl.style.display = 'block';
    const r = el.getBoundingClientRect();
    const w = panelGlossEl.offsetWidth || 120;
    panelGlossEl.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2)) + 'px';
    const top = r.top - panelGlossEl.offsetHeight - 6;
    // 贴到顶了就翻到词的下面显示
    panelGlossEl.style.top = (top < 4 ? r.bottom + 6 : top) + 'px';
  }

  function attachPanelHoverGloss(el) {
    el.addEventListener('mouseenter', () => {
      if (S.hoverGloss !== true) return; // 默认关闭，必须在设置里显式打开
      const line = el.closest('.tline');
      if (!line) return;
      const idx = parseInt(line.dataset.index, 10);
      const word = el.textContent;
      panelHoverEl = el;
      if (panelGlossTimer) clearTimeout(panelGlossTimer);
      panelGlossTimer = setTimeout(async () => {
        if (panelHoverEl !== el) return; // 延迟期间已经移走，请求都不用发
        const r = await sendToTab('YTLB_QUICK_GLOSS', { index: idx, word });
        // 内容脚本那边已经把结果写进缓存了，所以即使鼠标移开这次调用也不算白花
        if (panelHoverEl !== el) return;
        if (r && r.ok && r.gloss) {
          showPanelGloss(r.gloss, el);
        } else {
          // 失败要看得见，不能静默隐藏（否则"没反应"和"没配Key"没法区分）
          showPanelGloss('⚠ ' + String((r && r.error) || T('ov.explainFail')).slice(0, 60), el);
          if (panelGlossHideTimer) clearTimeout(panelGlossHideTimer);
          panelGlossHideTimer = setTimeout(hidePanelGloss, 3000);
        }
      }, 350);
    });
    el.addEventListener('mouseleave', () => {
      if (panelHoverEl === el) panelHoverEl = null;
      // 留一点缓冲，鼠标挪开一两像素不该让气泡立刻消失
      if (panelGlossHideTimer) clearTimeout(panelGlossHideTimer);
      panelGlossHideTimer = setTimeout(() => {
        if (!panelHoverEl) hidePanelGloss();
      }, 400);
    });
  }

  async function renderTranscriptList() {
    if (!S.trackedTabId) {
      $('#transcript-list').innerHTML = '';
      return;
    }
    const res = await sendToTab('YTLB_GET_TRANSCRIPT');
    if (!res || !res.entries) {
      $('#transcript-list').innerHTML = '<div class="hint">' + YTLB.escapeHtml(T('st.listEmpty')) + '</div>';
      return;
    }
    S.lastTranscript = res;
    const mode = segValue($('#view-mode')) || 'bilingual';

    // 内容没变就别重建 DOM。4秒一次的兜底轮询会调到这里，
    // 每次都 innerHTML 重建的话，当前句高亮、滚动位置和悬停气泡都会被冲掉。
    const translatedCount = res.entries.filter((e) => e.target).length;
    const sig = [res.videoId, res.entries.length, translatedCount, res.translationSource, res.targetLang, mode].join('|');
    if (S.lastRenderSig === sig) return;
    S.lastRenderSig = sig;

    // 这个按钮以前在"已经有译文"时是禁用的，等于 YouTube 翻得不好时用户没路可走。
    // 现在随时可点，点了会弹花费确认 —— 它是所有功能里最贵的一个。
    const btn = $('#btn-full-translate');
    S.transcriptLineCount = res.entries.length;
    btn.disabled = false;
    btn.textContent = T(res.translationSource === 'none' ? 'learn.transAll' : 'learn.transAllAgain');

    const list = $('#transcript-list');
    list.innerHTML = res.entries
      .map((e, i) => {
        const showOrig = mode !== 'target';
        const showTarget = mode !== 'original';
        return `
        <div class="tline" data-index="${i}">
          <span class="t-time" data-time="${e.start}">${YTLB.formatTime(e.start)}</span>
          ${showOrig ? `<div class="t-original">${wrapWordsHtml(e.original)}</div>` : ''}
          ${showTarget ? `<div class="t-target">${e.target ? YTLB.escapeHtml(e.target) : '<button class=\"line-translate\">' + YTLB.escapeHtml(T('learn.transLine')) + '</button>'}</div>` : ''}
          <div class="t-explain-slot"></div>
        </div>`;
      })
      .join('');

    list.querySelectorAll('.t-time').forEach((el) => {
      el.addEventListener('click', () => sendToTab('YTLB_SEEK', { time: parseFloat(el.dataset.time) }));
    });
    list.querySelectorAll('.line-translate').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const line = e.target.closest('.tline');
        const idx = parseInt(line.dataset.index, 10);
        e.target.textContent = T('st.lineTranslating');
        const r = await sendToTab('YTLB_TRANSLATE_LINE', { index: idx });
        if (r.ok) {
          line.querySelector('.t-target').textContent = r.target;
        } else {
          e.target.textContent = T('st.lineRetry');
        }
      });
    });
    list.querySelectorAll('.ytlb-word').forEach((el) => {
      attachPanelHoverGloss(el);
      el.addEventListener('click', async (e) => {
        hidePanelGloss();
        const line = e.target.closest('.tline');
        const idx = parseInt(line.dataset.index, 10);
        const word = e.target.textContent;
        const slot = line.querySelector('.t-explain-slot');
        slot.innerHTML = '<div class="t-explain">' + YTLB.escapeHtml(T('st.explainingShort')) + '</div>';
        if (S.settings && S.settings.clickExplain === false) return;
        const r = await sendToTab('YTLB_EXPLAIN_WORD', { index: idx, word });
        if (r.ok) {
          slot.innerHTML = `<div class="t-explain">${YTLB.escapeHtml(r.explanation)} <button class="explain-save">${T('learn.addVocab')}</button></div>`;
          slot.querySelector('.explain-save').addEventListener('click', async (ev) => {
            await sendToTab('YTLB_ADD_VOCAB', { payload: { index: idx, word, explanation: r.explanation } });
            ev.target.textContent = T('learn.addedVocab');
          });
        } else {
          slot.innerHTML = `<div class="t-explain">${YTLB.escapeHtml(T('st.failPrefix', { reason: r.error || '' }))}</div>`;
        }
      });
    });
  }

  // 字幕列表跟随播放自动滚动。
  // 真正的滚动容器是 #panels（#transcript-list 本身不滚），所以监听和滚动都挂在它上面。
  // 用户自己滚动时先让开（5秒内不抢滚动条），免得想往回翻却一直被拉回当前句。
  const scroller = $('#panels');
  scroller.addEventListener('wheel', () => {
    userScrolledAt = Date.now();
  });
  scroller.addEventListener('touchmove', () => {
    userScrolledAt = Date.now();
  });

  function highlightCurrentLine(index, playing) {
    let currentEl = null;
    $$('.tline').forEach((el) => {
      const isCur = parseInt(el.dataset.index, 10) === index;
      el.classList.toggle('current', isCur);
      if (isCur) currentEl = el;
    });
    if (!currentEl) return;
    if (S.followPlayback === false) return;
    // 视频暂停时绝不自动滚动。滚的是整个面板容器，语言下拉框也在里面，
    // 一滚就把用户正在操作的控件带出视野了。只有真的在播放才跟。
    if (playing === false) return;
    if (Date.now() - userScrolledAt < 5000) return;
    // 只有「字幕」页在前台时才滚，不然会把用户正在看的笔记页拽走
    if (!$('#panel-learn').classList.contains('active')) return;

    // 只在当前句快移出可视区时才滚，避免每句都抖一下
    const sr = scroller.getBoundingClientRect();
    const er = currentEl.getBoundingClientRect();
    if (er.top < sr.top + 8 || er.bottom > sr.bottom - 8) {
      const delta = er.top - sr.top - scroller.clientHeight / 3;
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: 'smooth' });
    }
  }

  segOnChange($('#view-mode'), async (mode) => {
    // 同时告诉内容脚本，让视频上的浮层跟着一起切
    await sendToTab('YTLB_SET_VIEW_MODE', { mode });
    renderTranscriptList();
  });
  // 按行数粗估花费。整篇翻译要把全部字幕发进去、再生成同样长度的译文，
  // 是所有功能里最贵的 —— 点之前必须让人知道大概多少钱。
  function estimateFullTranslateCost(lines) {
    const inTok = (lines * 40) / 4 + Math.ceil(lines / 30) * 110 + lines * 3;
    const outTok = (lines * 40 * 0.6) / 1.5;
    // 直接返回美元，不再乘汇率
    return (inTok / 1e6) * 0.44 + (outTok / 1e6) * 1.32;
  }

  $('#btn-full-translate').addEventListener('click', async () => {
    const lines = S.transcriptLineCount || 0;
    const cost = money(estimateFullTranslateCost(lines));
    if (!confirm(T('learn.transAllConfirm', { n: lines, cost }))) return;

    $('#translate-progress').textContent = T('st.allTranslating');
    const r = await sendToTab('YTLB_TRANSLATE_ALL');
    $('#translate-progress').textContent = r.ok ? T('st.allDone') : T('st.failPrefix', { reason: r.error || '' });
    if (r.ok) {
      S.lastRenderSig = null;
      renderTranscriptList();
    }
  });

  // ---------------- 大纲 ----------------
  function renderOutline(outline) {
    // 广告段直接不显示。时间戳仍然是真实的，跳转不受影响。
    const items = ((outline && outline.items) || []).filter((it) => !it.ad && (it.summary || '').trim());
    if (!items.length) {
      $('#outline-chapters').innerHTML = '<div class="hint">' + YTLB.escapeHtml(T('outline.empty')) + '</div>';
      return;
    }
    $('#outline-chapters').innerHTML =
      '<div class="outline-summary">' +
      items
        .map(
          (it) => `
        <div class="outline-point" data-time="${it.start}">
          <div class="outline-head"><span class="chapter-time">${YTLB.formatTime(it.start)}</span>${it.title ? `<span class="outline-title">${YTLB.escapeHtml(it.title)}</span>` : ''}</div>
          <div class="outline-text">${YTLB.escapeHtml(it.summary || '')}</div>
        </div>`
        )
        .join('') +
      '</div>';
    $$('#outline-chapters .outline-point').forEach((el) => {
      el.addEventListener('click', () => sendToTab('YTLB_SEEK', { time: parseFloat(el.dataset.time) }));
    });
  }

  $('#btn-gen-outline').addEventListener('click', async () => {
    $('#outline-hint').textContent = T('outline.generating');
    const r = await sendToTab('YTLB_GET_OUTLINE');
    if (r.ok) {
      $('#outline-hint').textContent = T(r.cached ? 'outline.cached' : 'outline.done');
      renderOutline(r.outline);
    } else {
      $('#outline-hint').textContent = T('st.failPrefix', { reason: r.error || '' });
    }
  });

  // ---------------- 笔记 ----------------
  async function renderNotes() {
    const entries = await YTLB.getEntries();
    entries.sort((a, b) => b.createdAt - a.createdAt);
    $('#notes-count').textContent = T('notes.count', { n: entries.length });
    $('#notes-list').innerHTML = entries
      .map(
        (n) => `
      <div class="note-item" data-id="${n.id}">
        <div class="note-video"><a class="note-jump" data-video="${n.videoId}" data-time="${n.time}">${YTLB.escapeHtml(n.videoTitle)} · ${YTLB.formatTime(n.time)}</a></div>
        <div class="note-orig">${YTLB.highlightHtml(n.original, hlTerms(n))}</div>
        ${n.translation ? `<div class="note-trans">${YTLB.highlightHtml(n.translation, hlTerms(n))}</div>` : ''}
        ${n.explainedWord ? `<div class="note-explain"><b>${YTLB.escapeHtml(n.explainedWord)}</b>：${YTLB.escapeHtml(n.explanation)}</div>` : ''}
        <textarea class="note-annotate" placeholder="${YTLB.escapeHtml(T('notes.annotate'))}">${YTLB.escapeHtml(n.note || '')}</textarea>
        <div class="note-actions">
          <button class="note-copy-orig">${T('notes.copyOrig')}</button>
          <button class="note-copy-all">${T('notes.copyAll')}</button>
          <button class="note-edit">${T('notes.edit')}</button>
          <button class="note-replay">${T('notes.replay')}</button>
          <button class="note-delete">${T('notes.delete')}</button>
          <span class="note-saved"></span>
        </div>
      </div>`
      )
      .join('');

    $('#notes-list').querySelectorAll('.note-jump').forEach((el) => {
      el.addEventListener('click', () => jumpToVideo(el.dataset.video, parseFloat(el.dataset.time)));
    });
    $('#notes-list').querySelectorAll('.note-copy-orig').forEach((el) =>
      el.addEventListener('click', (e) => copyText(findEntry(entries, e).original))
    );
    // 全部复制 = 原文 + 译文 + 你写的注解，一次拿走整条笔记
    $('#notes-list').querySelectorAll('.note-copy-all').forEach((el) =>
      el.addEventListener('click', (e) => {
        const n = findEntry(entries, e);
        const item = e.target.closest('.note-item');
        const note = item.querySelector('.note-annotate').value.trim();
        const parts = [n.original, n.translation, n.explainedWord ? `${n.explainedWord}：${n.explanation}` : '', note];
        copyText(parts.filter(Boolean).join('\n'));
        e.target.textContent = T('learn.copied');
        setTimeout(() => (e.target.textContent = T('notes.copyAll')), 1500);
      })
    );
    $('#notes-list').querySelectorAll('.note-replay').forEach((el) =>
      el.addEventListener('click', (e) => {
        const n = findEntry(entries, e);
        jumpToVideo(n.videoId, n.time);
      })
    );
    // 注解自动保存：停止输入 800ms 后存一次，失焦时再存一次兜底。
    // 手动点"保存"这一步没有存在的必要 —— 忘了点就丢内容，而这种丢法用户根本察觉不到。
    $('#notes-list').querySelectorAll('.note-annotate').forEach((ta) => {
      let timer = null;
      const save = async () => {
        const item = ta.closest('.note-item');
        const id = item.dataset.id;
        const all = await YTLB.getEntries();
        const idx = all.findIndex((x) => x.id === id);
        if (idx < 0) return;
        if (all[idx].note === ta.value) return;
        all[idx].note = ta.value;
        await YTLB.saveEntries(all);
        const flag = item.querySelector('.note-saved');
        if (flag) {
          flag.textContent = T('notes.saved');
          setTimeout(() => (flag.textContent = ''), 1800);
        }
      };
      ta.addEventListener('input', () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 800);
      });
      ta.addEventListener('blur', () => {
        if (timer) clearTimeout(timer);
        save();
      });
    });
    $('#notes-list').querySelectorAll('.note-edit').forEach((el) =>
      el.addEventListener('click', (e) => {
        const card = e.target.closest('.note-item');
        openCardEditor(card, false, entries.find((x) => x.id === card.dataset.id));
      })
    );
    $('#notes-list').querySelectorAll('.note-delete').forEach((el) =>
      el.addEventListener('click', async (e) => {
        const item = e.target.closest('.note-item');
        const id = item.dataset.id;
        const all = await YTLB.getEntries();
        await YTLB.saveEntries(all.filter((x) => x.id !== id));
        renderNotes();
      })
    );
  }

  function findEntry(entries, e) {
    const id = e.target.closest('.note-item').dataset.id;
    return entries.find((x) => x.id === id);
  }

  function copyText(text) {
    navigator.clipboard.writeText(text || '').catch(() => {});
  }

  async function jumpToVideo(videoId, time) {
    if (S.trackedVideoId === videoId && S.trackedTabId) {
      await sendToTab('YTLB_SEEK', { time });
      return;
    }
    if (S.trackedTabId) {
      chrome.tabs.update(S.trackedTabId, { url: `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(time)}s` });
    } else {
      chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(time)}s` });
    }
  }

  // ---------------- 生词本 ----------------
  async function renderVocab() {
    const vocab = await YTLB.getVocab();
    vocab.sort((a, b) => b.createdAt - a.createdAt);
    $('#vocab-count').textContent = T('vocab.count', { n: vocab.length });
    $('#vocab-list').innerHTML = vocab
      .map(
        (v) => `
      <div class="vocab-item" data-id="${v.id}">
        <div class="note-video"><a class="note-jump" data-video="${v.videoId}" data-time="${v.time}">${YTLB.escapeHtml(v.videoTitle)} · ${YTLB.formatTime(v.time)}</a></div>
        <div class="note-orig"><b>${YTLB.escapeHtml(v.word)}</b></div>
        <div class="vocab-example">${YTLB.highlightHtml(v.sentenceOriginal, hlTerms(v))}</div>
        ${v.sentenceTranslation ? `<div class="note-trans">${YTLB.highlightHtml(v.sentenceTranslation, hlTerms(v))}</div>` : ''}
        <div class="note-explain">${YTLB.escapeHtml(v.explanation)}</div>
        ${v.explanationDeep ? `<div class="vocab-deep-text"><span class="vocab-deep-tag">${T('vocab.deepTag')}</span>${YTLB.escapeHtml(v.explanationDeep)}</div>` : ''}
        <div class="note-actions">
          <button class="note-copy-word">${T('vocab.copyWord')}</button>
          <button class="vocab-copy-all">${T('notes.copyAll')}</button>
          <button class="note-edit">${T('notes.edit')}</button>
          <button class="note-replay">${T('notes.replay')}</button>
          <button class="vocab-deep">${T(v.explanationDeep ? 'learn.deepExplainAgain' : 'learn.deepExplain')}</button>
          <button class="note-delete">${T('notes.delete')}</button>
        </div>
      </div>`
      )
      .join('');
    $('#vocab-list').querySelectorAll('.note-jump').forEach((el) =>
      el.addEventListener('click', () => jumpToVideo(el.dataset.video, parseFloat(el.dataset.time)))
    );
    $('#vocab-list').querySelectorAll('.note-copy-word').forEach((el) =>
      el.addEventListener('click', (e) => copyText(findVocab(vocab, e).word))
    );
    // 全部复制 = 整张卡片：生词 + 例句 + 例句译文 + 解释
    $('#vocab-list').querySelectorAll('.vocab-copy-all').forEach((el) =>
      el.addEventListener('click', (e) => {
        const v = findVocab(vocab, e);
        copyText([v.word, v.sentenceOriginal, v.sentenceTranslation, v.explanation, v.explanationDeep].filter(Boolean).join('\n'));
        e.target.textContent = T('learn.copied');
        setTimeout(() => (e.target.textContent = T('notes.copyAll')), 1500);
      })
    );
    $('#vocab-list').querySelectorAll('.note-replay').forEach((el) =>
      el.addEventListener('click', (e) => {
        const v = findVocab(vocab, e);
        jumpToVideo(v.videoId, v.time);
      })
    );
    $('#vocab-list').querySelectorAll('.vocab-deep').forEach((el) =>
      el.addEventListener('click', async (e) => {
        const card = e.target.closest('.vocab-item');
        const v = vocab.find((x) => x.id === card.dataset.id);
        if (!v) return;
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = T('learn.deepExplaining');
        // index 传 -1：生词可能来自别的视频，当前页面的字幕里找不到它，
        // 那时就只带句子、不带上下文
        const r = await sendToTab('YTLB_EXPLAIN_DEEP', {
          index: -1,
          word: v.word,
          sentence: v.sentenceOriginal || '',
          hasBrief: !!v.explanation,
        });
        if (r && r.ok && r.explanation) {
          const all = await YTLB.getVocab();
          const i = all.findIndex((x) => x.id === v.id);
          if (i >= 0) {
            // 存成独立字段而不是覆盖 explanation：覆盖的话详细解释就必须把词义再讲
            // 一遍才完整，用户等于为同一段内容付两次钱。两份并存，它就能只讲用法。
            all[i].explanationDeep = r.explanation;
            await YTLB.saveVocab(all);
          }
          renderVocab();
        } else {
          btn.disabled = false;
          btn.textContent = T(v.explanationDeep ? 'learn.deepExplainAgain' : 'learn.deepExplain');
          flashListHint(T('st.failPrefix', { reason: (r && r.error) || T('st.unknownError') }));
        }
      })
    );
    $('#vocab-list').querySelectorAll('.note-edit').forEach((el) =>
      el.addEventListener('click', (e) => {
        const card = e.target.closest('.vocab-item');
        openCardEditor(card, true, vocab.find((x) => x.id === card.dataset.id));
      })
    );
    $('#vocab-list').querySelectorAll('.note-delete').forEach((el) =>
      el.addEventListener('click', async (e) => {
        const id = e.target.closest('.vocab-item').dataset.id;
        const all = await YTLB.getVocab();
        await YTLB.saveVocab(all.filter((x) => x.id !== id));
        renderVocab();
      })
    );
  }
  function findVocab(vocab, e) {
    const id = e.target.closest('.vocab-item').dataset.id;
    return vocab.find((x) => x.id === id);
  }

  // storage变化时（比如浮层里收藏了生词）自动刷新对应标签
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.ytlb_entries && $('#panel-notes').classList.contains('active')) renderNotes();
    if (changes.ytlb_vocab && $('#panel-vocab').classList.contains('active')) renderVocab();
  });

  // ---------------- 导出 ----------------
  function csvEscape(s) {
    s = String(s == null ? '' : s);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // 导出字幕全文时也要标出你标过的词。
  // 只取**当前这个视频**的笔记/生词里的词 —— 别的视频的生词混进来，
  // 会把一些常见词在全文里到处标黄，反而看不出重点。
  function transcriptTerms(notes, vocab, videoId) {
    if (!videoId) return [];
    const out = [];
    (notes || []).forEach((n) => {
      if (n.videoId !== videoId) return;
      out.push(...hlTerms(n));
    });
    (vocab || []).forEach((v) => {
      if (v.videoId !== videoId) return;
      out.push(...hlTerms(v));
    });
    // 去重，长的排前面（词组优先于它内部的单词）
    const seen = new Set();
    return out
      .filter((t) => {
        const k = String(t).toLowerCase();
        if (!t || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.length - a.length);
  }

  function buildMarkdown(notes, vocab, transcript, terms, mode) {
    let md = T('x.title') + '\n\n';
    if (notes && notes.length) {
      md += T('x.notes') + '\n\n';
      const byVideo = {};
      notes.forEach((n) => {
        (byVideo[n.videoTitle] = byVideo[n.videoTitle] || []).push(n);
      });
      Object.keys(byVideo).forEach((title) => {
        md += `### ${title}\n\n`;
        byVideo[title].forEach((n) => {
          md += `- ${YTLB.highlightMd(n.original, hlTerms(n))}\n`;
          if (n.translation) md += `  - ${T('x.trans')}${YTLB.highlightMd(n.translation, hlTerms(n))}\n`;
          if (n.explainedWord) md += `  - ${T('x.word', { word: n.explainedWord })}${n.explanation}\n`;
          if (n.note) md += `  - ${T('x.note')}${n.note}\n`;
        });
        md += '\n';
      });
    }
    if (vocab && vocab.length) {
      md += T('x.vocab') + '\n\n';
      vocab.forEach((v) => {
        md += `- **${v.word}**\n`;
        md += `  - ${T('x.example')}${YTLB.highlightMd(v.sentenceOriginal, hlTerms(v))}\n`;
        if (v.sentenceTranslation) md += `  - ${T('x.trans')}${v.sentenceTranslation}\n`;
        md += `  - ${T('x.explain')}${v.explanation}\n`;
        if (v.explanationDeep) md += `  - ${T('x.deep')}${v.explanationDeep}
`;
      });
      md += '\n';
    }
    if (transcript && transcript.length) {
      md += T('x.transcript') + '\n\n';
      transcript.forEach((e) => {
        // 译文也过一遍高亮：用户可以在译文上按 H 标记，那些词同样在 terms 里
        const o = YTLB.highlightMd(e.original, terms);
        const t = YTLB.highlightMd(e.target || '', terms);
        if (mode === 'target') md += `- ${t}\n`;
        else if (mode === 'original') md += `- ${o}\n`;
        else md += `- ${o}${e.target ? '　/　' + t : ''}\n`;
      });
    }
    return md;
  }

  // HTML 导出：给"高亮要真的看起来像高亮"这个需求用的。
  //
  // 没做 .docx，理由是不划算：docx 本质是一个 ZIP 包着几份 XML，
  // 浏览器扩展里既不能引外部库（CSP 挡着），自己实现 ZIP 写入器加 CRC32
  // 又是几百行只为了换个后缀。而 HTML 这条路成本几乎为零，且：
  //   - 浏览器直接打开就能看，颜色、链接都在
  //   - Word 能直接打开 .html，高亮和格式保留，再另存为 .docx 就是标准 Word 文件
  //   - 复制粘贴进 Word / Google Docs / Notion，格式也跟着走
  // 样式全部内联，是一个单文件，随便拷到哪都不会掉样式。
  function buildHtml(notes, vocab, transcript, terms, mode) {
    const esc = YTLB.escapeHtml;
    const hl = YTLB.highlightHtml;
    const p = [];
    p.push(
      '<!doctype html><html><head><meta charset="utf-8">',
      '<title>' + esc(T('x.title').replace(/^#\s*/, '')) + '</title>',
      '<style>',
      'body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
      'max-width:760px;margin:32px auto;padding:0 20px;color:#1e1e1e}',
      'h1{font-size:22px;border-bottom:2px solid #c8940f;padding-bottom:8px}',
      'h2{font-size:17px;margin-top:32px;color:#b8830a}',
      'h3{font-size:14px;color:#555;margin:20px 0 8px;font-weight:600}',
      '.item{margin:0 0 14px;padding-left:12px;border-left:3px solid #e6e6e6}',
      '.word{font-size:16px;font-weight:700}',
      '.sub{color:#4a4a4a;margin:2px 0}',
      '.label{color:#757575;font-size:12px}',
      '.line{margin:1px 0}',
      '.time{color:#757575;font-size:12px;text-decoration:none;margin-right:6px}',
      '.time:hover{color:#b8830a;text-decoration:underline}',
      'mark.ytlb-hl{background:#fbe6ab;color:inherit;border-radius:3px;padding:0 2px}',
      '@media print{body{margin:0}a{color:inherit}}',
      '</style></head><body>',
      '<h1>' + esc(T('x.title').replace(/^#\s*/, '')) + '</h1>'
    );

    if (notes && notes.length) {
      p.push('<h2>' + esc(T('x.notes').replace(/^#+\s*/, '')) + '</h2>');
      const byVideo = {};
      notes.forEach((n) => (byVideo[n.videoTitle] = byVideo[n.videoTitle] || []).push(n));
      Object.keys(byVideo).forEach((title) => {
        p.push('<h3>' + esc(title) + '</h3>');
        byVideo[title].forEach((n) => {
          p.push('<div class="item">');
          const t = YTLB.formatTime(n.time);
          p.push(
            n.videoUrl
              ? '<a class="time" href="' + esc(n.videoUrl) + '">' + esc(t) + '</a>'
              : '<span class="time">' + esc(t) + '</span>'
          );
          p.push('<span>' + hl(n.original, hlTerms(n)) + '</span>');
          if (n.translation) p.push('<div class="sub">' + hl(n.translation, hlTerms(n)) + '</div>');
          if (n.explainedWord)
            p.push('<div class="sub"><b>' + esc(n.explainedWord) + '</b>：' + esc(n.explanation) + '</div>');
          if (n.note) p.push('<div class="sub"><span class="label">' + esc(T('x.note')) + '</span>' + esc(n.note) + '</div>');
          p.push('</div>');
        });
      });
    }

    if (vocab && vocab.length) {
      p.push('<h2>' + esc(T('x.vocab').replace(/^#+\s*/, '')) + '</h2>');
      vocab.forEach((v) => {
        p.push('<div class="item">');
        p.push('<div class="word">' + esc(v.word) + '</div>');
        p.push('<div class="sub">' + hl(v.sentenceOriginal, hlTerms(v)) + '</div>');
        if (v.sentenceTranslation) p.push('<div class="sub">' + esc(v.sentenceTranslation) + '</div>');
        if (v.explanation) p.push('<div class="sub">' + esc(v.explanation) + '</div>');
        if (v.explanationDeep)
          p.push('<div class="sub">' + esc(T('x.deep')) + esc(v.explanationDeep) + '</div>');
        p.push('</div>');
      });
    }

    if (transcript && transcript.length) {
      p.push('<h2>' + esc(T('x.transcript').replace(/^#+\s*/, '')) + '</h2>');
      transcript.forEach((e) => {
        p.push('<div class="line">');
        if (mode === 'target') {
          p.push(hl(e.target || '', terms));
        } else {
          p.push(hl(e.original, terms));
          if (mode !== 'original' && e.target) p.push(' <span class="label">/ ' + hl(e.target, terms) + '</span>');
        }
        p.push('</div>');
      });
    }

    p.push('</body></html>');
    return p.join('');
  }

  function buildCsv(notes, vocab, transcript, mode) {
    const rows = [[T('x.csvType'), T('x.csvVideo'), T('x.csvOrig'), T('x.csvTrans'), T('x.csvExplain'), T('x.csvNote'), T('x.csvDeep')]];
    (notes || []).forEach((n) =>
      rows.push([T('x.rowNote'), n.videoTitle, n.original, n.translation || '', n.explainedWord ? `${n.explainedWord}：${n.explanation}` : '', n.note || '', ''])
    );
    (vocab || []).forEach((v) =>
      rows.push([T('x.rowVocab'), v.videoTitle, v.word, v.sentenceTranslation || '', v.explanation || '', v.sentenceOriginal || '', v.explanationDeep || ''])
    );
    (transcript || []).forEach((e) =>
      rows.push([
        T('x.rowLine'),
        '',
        mode === 'target' ? '' : e.original,
        mode === 'original' ? '' : e.target || '',
        '',
        '',
        '',
      ])
    );
    return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  }

  function download(filename, mime, content) {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  let exportScope = 'notes';
  $$('.export-btn').forEach((b) =>
    b.addEventListener('click', () => {
      exportScope = b.dataset.scope;
      $('#exp-include-notes').checked = exportScope === 'notes';
      $('#exp-include-vocab').checked = exportScope === 'vocab';
      syncExpSub();
      $('#export-modal').classList.remove('hidden');
    })
  );
  // 「原文 / 双语」只对字幕全文有意义，没勾就置灰
  function syncExpSub() {
    $('.exp-sub').classList.toggle('off', !$('#exp-include-transcript').checked);
  }
  $('#exp-include-transcript').addEventListener('change', syncExpSub);

  $('#exp-cancel').addEventListener('click', () => $('#export-modal').classList.add('hidden'));
  $('#exp-confirm').addEventListener('click', async () => {
    const includeNotes = $('#exp-include-notes').checked;
    const includeVocab = $('#exp-include-vocab').checked;
    const includeTranscript = $('#exp-include-transcript').checked;
    const format = document.querySelector('input[name=exp-format]:checked').value;

    // 先无条件读出来：即使这次不导出笔记/生词，字幕全文的高亮也要靠它们提供词表
    const allNotes = await YTLB.getEntries();
    const allVocab = await YTLB.getVocab();
    const notes = includeNotes ? allNotes : [];
    const vocab = includeVocab ? allVocab : [];
    let transcript = [];
    if (includeTranscript && S.trackedTabId) {
      const r = await sendToTab('YTLB_GET_TRANSCRIPT');
      if (r && r.entries) transcript = r.entries;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const terms = transcriptTerms(allNotes, allVocab, S.lastState && S.lastState.videoId);
    // 字幕全文导原文还是双语。只影响字幕那一节 —— 笔记和生词本来就是原文+译文成对的
    const mode = document.querySelector('input[name=exp-trans-mode]:checked').value;
    if (format === 'csv') {
      download(`lingopal-${stamp}.csv`, 'text/csv', buildCsv(notes, vocab, transcript, mode));
    } else if (format === 'html') {
      download(`lingopal-${stamp}.html`, 'text/html', buildHtml(notes, vocab, transcript, terms, mode));
    } else {
      download(`lingopal-${stamp}.md`, 'text/markdown', buildMarkdown(notes, vocab, transcript, terms, mode));
    }
    $('#export-modal').classList.add('hidden');
  });

  // ---------------- 界面语言 ----------------
  // 'auto' 表示跟随浏览器；用户选了具体语言就以他的选择为准。
  function applyUiLang(pref) {
    YTI18N.setLang(pref && pref !== 'auto' ? pref : YTI18N.detect());
    YTI18N.applyDom();
    // 帮助文字里带链接，不能直接 textContent，单独拼
    const link = '<a href="https://platform.deepseek.com" target="_blank">platform.deepseek.com</a>';
    const parts = T('set.help', { link: '\u0000' }).split('\u0000');
    $('#settings-help').innerHTML = YTLB.escapeHtml(parts[0] || '') + link + YTLB.escapeHtml(parts[1] || '');
    document.documentElement.lang = YTI18N.getLang();
  }

  // 换语言后，所有动态生成的内容都要重画一遍 —— 它们的文字是渲染时写死的
  function rerenderAll() {
    S.lastRenderSig = null;
    // 语言候选按钮是渲染时写死文字的，换语言后要强制重建
    $('#target-lang-select').innerHTML = '';
    refreshBanner();
    renderUsage();
    if ($('#panel-notes').classList.contains('active')) renderNotes();
    if ($('#panel-vocab').classList.contains('active')) renderVocab();
  }

  // ---------------- 设置 ----------------
  async function loadSettingsIntoForm() {
    const s = await YTLB.getSettings();
    S.settings = s;
    $('#set-uiLang').value = s.uiLang || 'auto';
    $('#set-apiKey').value = s.apiKey || '';
    $('#set-baseUrl').value = s.baseUrl || '';
    $('#set-translateModel').value = s.translateModel || '';
    $('#set-reasonModel').value = s.reasonModel || '';
    $('#set-targetLang').value = s.targetLang || 'zh';
    $('#set-qualityFirst').checked = !!s.qualityFirst;
    $('#set-autoClean').checked = !!s.autoClean;
    $('#set-autoSave').checked = !!s.autoSave;
    $('#set-overlayEnabled').checked = s.overlayEnabled !== false;
    $('#set-hoverGloss').checked = s.hoverGloss === true;
    $('#set-clickExplain').checked = s.clickExplain !== false;
    $('#set-explainLang').value = s.explainLang || 'target'; // 默认关，必须显式打开
    $('#set-followPlayback').checked = s.followPlayback !== false;
    $('#set-stickyCurrent').checked = s.stickyCurrent !== false;
    $('#set-pauseOnExplain').checked = s.pauseOnExplain !== false;
    applySticky(s.stickyCurrent !== false);
    // 视图模式要记住上次的选择，否则每次打开面板都跳回"双语对照"
    segSet($('#view-mode'), s.viewMode || 'bilingual');
    S.followPlayback = s.followPlayback !== false;
    S.hoverGloss = s.hoverGloss === true;
  }

  // 界面语言当场生效，不用等"保存设置"
  $('#set-uiLang').addEventListener('change', async (e) => {
    const pref = e.target.value;
    S.settings = await YTLB.saveSettings({ uiLang: pref });
    applyUiLang(pref);
    rerenderAll();
    if (S.trackedTabId) sendToTab('YTLB_SETTINGS_CHANGED');
  });

  $('#btn-save-settings').addEventListener('click', async () => {
    const patch = {
      uiLang: $('#set-uiLang').value,
      apiKey: $('#set-apiKey').value.trim(),
      baseUrl: $('#set-baseUrl').value.trim() || 'https://api.deepseek.com',
      translateModel: $('#set-translateModel').value.trim() || 'deepseek-v4-flash',
      reasonModel: $('#set-reasonModel').value.trim() || 'deepseek-v4-pro',
      targetLang: $('#set-targetLang').value,
      qualityFirst: $('#set-qualityFirst').checked,
      autoClean: $('#set-autoClean').checked,
      autoSave: $('#set-autoSave').checked,
      overlayEnabled: $('#set-overlayEnabled').checked,
      hoverGloss: $('#set-hoverGloss').checked,
      clickExplain: $('#set-clickExplain').checked,
      explainLang: $('#set-explainLang').value,
      followPlayback: $('#set-followPlayback').checked,
      stickyCurrent: $('#set-stickyCurrent').checked,
      pauseOnExplain: $('#set-pauseOnExplain').checked,
      viewMode: segValue($('#view-mode')) || 'bilingual',
    };
    S.settings = await YTLB.saveSettings(patch);
    S.followPlayback = patch.followPlayback;
    S.hoverGloss = patch.hoverGloss;
    applySticky(patch.stickyCurrent);
    $('#settings-hint').textContent = T(patch.apiKey ? 'set.saved' : 'set.savedNoKey');
    updateSetupBanner();
    if (S.trackedTabId) sendToTab('YTLB_SETTINGS_CHANGED');
  });

  // ---------------- AI 用量统计 ----------------
  // 单价来源：DeepSeek 官方定价页（美元/百万token）。这里一律按高峰价算，
  // 宁可估高不估低，免得给出比实际便宜的错觉。
  const PRICING = {
    'deepseek-v4-flash': { in: 0.44, out: 1.32 },
    'deepseek-v4-pro': { in: 1.32, out: 3.96 },
  };

  // 币种跟着界面语言走：DeepSeek 的中文界面按人民币计费、英文界面按美元计费，
  // 用哪种界面的人多半就是哪种账户。
  //
  // PRICING 表里的数是美元/百万 token，人民币靠汇率换算 ——
  // DeepSeek 的人民币价是单独定的，未必正好等于美元价乘汇率，所以这只是估算。
  // 汇率写成常量而不是藏起来：用量说明里会把它显示出来，看到数字对不上时
  // 至少知道该怀疑什么。要校准就改这一行。
  const USD_TO_CNY = 7.1;

  function useCny() {
    return YTI18N.getLang() === 'zh';
  }

  // 金额跨度很大（单次取词 $0.000006，整篇翻译可能上 $0.05），
  // 固定小数位不是全是 0 就是长得没法看，所以按量级选位数。
  function money(usd) {
    const cny = useCny();
    const v = (cny ? usd * USD_TO_CNY : usd) || 0;
    const sym = cny ? '¥' : '$';
    const a = Math.abs(v);
    if (a === 0) return sym + '0';
    if (a < 0.001) return sym + v.toFixed(6);
    if (a < 0.1) return sym + v.toFixed(4);
    return sym + v.toFixed(3);
  }

  function priceFor(model) {
    if (PRICING[model]) return PRICING[model];
    // 模型名被用户改过时，按贵的那档估，避免低估
    return PRICING['deepseek-v4-pro'];
  }

  async function renderUsage() {
    const { ytlb_usage: u } = await chrome.storage.local.get({ ytlb_usage: null });
    const body = $('#usage-body');
    if (!u || !u.calls) {
      body.textContent = T('usage.empty');
      return;
    }
    let usd = 0;
    Object.keys(u.byModel).forEach((m) => {
      const d = u.byModel[m];
      const p = priceFor(m);
      usd += (d.promptTokens / 1e6) * p.in + (d.completionTokens / 1e6) * p.out;
    });

    // 按功能列出来才看得出钱是谁花的（悬停速查和整篇翻译用的是同一个模型档）
    const feat = u.byFeature || {};
    // 'other' 是没打标签的内部调用（目前只有无标点字幕的断句辅助）。
    // 不单独列一行 —— 用户不知道有这个机制，列出来只会引出"这是什么"的疑问。
    // 它的花费仍然算在上面的总额里，不是隐藏开销。
    // 先按"规范键"合并。旧版本存的是中文功能名，新版本存的是英文键，
    // 两者指向同一个功能 —— 不合并的话会出现两行同名记录。
    const merged = {};
    Object.keys(feat).forEach((name) => {
      if (name === 'other' || featHidden(name)) return;
      const canon = FEAT_KEY[name] || name;
      const d = feat[name];
      if (!merged[canon]) merged[canon] = { calls: 0, promptTokens: 0, completionTokens: 0, model: d.model };
      merged[canon].calls += d.calls;
      merged[canon].promptTokens += d.promptTokens;
      merged[canon].completionTokens += d.completionTokens;
      merged[canon].model = d.model;
    });

    const featRows = Object.keys(merged)
      .map((canon) => {
        const d = merged[canon];
        const p = priceFor(d.model);
        const cost = (d.promptTokens / 1e6) * p.in + (d.completionTokens / 1e6) * p.out;
        return { label: T(canon), calls: d.calls, cost, model: d.model };
      })
      .sort((a, b) => b.cost - a.cost)
      .map(
        (r) =>
          `<div class="usage-row"><span>${YTLB.escapeHtml(r.label)}<em class="usage-model">${YTLB.escapeHtml(
            String(r.model || '').replace(/^deepseek-/, '')
          )}</em></span><span>${YTLB.escapeHtml(T('usage.calls', { n: r.calls, cost: money(r.cost) }))}</span></div>`
      );

    // 金额要加粗，但不能把 <b> 塞进翻译字符串里（那样每种语言都得记得带标签）。
    // 用一个不可能出现在正文里的占位符切开，两边分别转义后再拼。
    const MARK = '\u0000';
    const parts = T('usage.total', { cost: MARK, n: u.calls }).split(MARK);
    const totalHtml =
      YTLB.escapeHtml(parts[0] || '') + `<b>${money(usd)}</b>` + YTLB.escapeHtml(parts[1] || '');
    body.innerHTML = `
      <div class="usage-total">${totalHtml}</div>
      ${featRows.join('')}
      <div class="usage-row"><span>${YTLB.escapeHtml(T('usage.tokens'))}</span><span>${u.promptTokens} / ${u.completionTokens}</span></div>
      <div class="usage-row ${u.reasoningTokens > 0 ? 'usage-warn' : ''}"><span>${YTLB.escapeHtml(
        T('usage.reasoning')
      )}</span><span>${u.reasoningTokens}</span></div>
    `;
  }

  $('#btn-reset-usage').addEventListener('click', async () => {
    await chrome.storage.local.set({ ytlb_usage: null });
    renderUsage();
  });

  // ---------------- 诊断 ----------------
  // 一次性把整条链路走通并报告每一环的实际状态。
  // 出问题时靠这个定位，比让用户去翻 Chrome 的错误面板可靠得多。
  // ---------------- 数据备份 / 恢复 ----------------
  // 卸载扩展时 Chrome 会把 chrome.storage.local 一起删掉，没有撤销。
  // 而 Markdown / CSV / HTML 那几个导出是给人读的，结构化信息（id、时间戳、
  // 视频链接、高亮词表）都丢了，导不回来。所以单独做一份 JSON 备份。
  //
  // 不含 API Key：备份文件很可能被丢进网盘或发给别人，Key 不该跟着走。
  const BACKUP_TAG = 'youtube-lingopal-backup';

  $('#btn-backup-export').addEventListener('click', async () => {
    const [notes, vocab, settings] = await Promise.all([YTLB.getEntries(), YTLB.getVocab(), YTLB.getSettings()]);
    const safe = Object.assign({}, settings);
    delete safe.apiKey;
    const data = {
      tag: BACKUP_TAG,
      version: 1,
      exportedAt: new Date().toISOString(),
      notes,
      vocab,
      settings: safe,
    };
    const stamp = new Date().toISOString().slice(0, 10);
    download(`lingopal-backup-${stamp}.json`, 'application/json', JSON.stringify(data, null, 2));
    $('#backup-hint').textContent = T('backup.exported');
    setTimeout(() => ($('#backup-hint').textContent = ''), 2000);
  });

  $('#btn-backup-import').addEventListener('click', () => $('#backup-file').click());

  $('#backup-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 清掉，否则同一个文件选第二次不触发 change
    if (!file) return;
    const hint = $('#backup-hint');
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      hint.textContent = T('backup.bad');
      return;
    }
    if (!data || data.tag !== BACKUP_TAG || !Array.isArray(data.notes) || !Array.isArray(data.vocab)) {
      hint.textContent = T('backup.bad');
      return;
    }

    // 合并而不是覆盖：导入不该把现有内容抹掉。按 id 去重，
    // 老备份里没有 id 的（理论上不会有）退化成按 视频+时间+原文 判重。
    const [curNotes, curVocab] = await Promise.all([YTLB.getEntries(), YTLB.getVocab()]);
    const sig = (x) => x.id || [x.videoId, x.time, x.original || x.word].join('|');
    const seenN = new Set(curNotes.map(sig));
    const seenV = new Set(curVocab.map(sig));
    const addN = data.notes.filter((x) => !seenN.has(sig(x)));
    const addV = data.vocab.filter((x) => !seenV.has(sig(x)));

    if (!addN.length && !addV.length) {
      hint.textContent = T('backup.dup');
      return;
    }
    if (addN.length) await YTLB.saveEntries(curNotes.concat(addN));
    if (addV.length) await YTLB.saveVocab(curVocab.concat(addV));
    hint.textContent = T('backup.done', { notes: addN.length, vocab: addV.length });
    renderNotes();
    renderVocab();
  });

  $('#btn-diagnose').addEventListener('click', async () => {
    const out = $('#diag-out');
    out.classList.remove('hidden');
    out.textContent = '…';
    const L = [];
    const mark = (ok, label, detail) => L.push((ok ? '[OK]  ' : '[!!]  ') + label + (detail ? ' — ' + detail : ''));

    try {
      const s = await YTLB.getSettings();
      // 标签尽量复用设置页已有的文案，只有诊断特有的才新增条目
      mark(true, T('set.uiLang'), T('diag.actual', { pref: s.uiLang || 'auto', real: YTI18N.getLang() }));
      mark(!!s.apiKey, T('set.apiKey'), s.apiKey ? T('diag.filled', { head: s.apiKey.slice(0, 6) }) : T('diag.empty'));
      mark(true, T('set.defaultLang'), s.targetLang || T('diag.unset'));
      // 关闭是**默认且正确**的状态，不该标成 [!!]。原来标了，看起来像有东西坏了。
      // 这一行的作用只是告诉你开关在哪个位置，所以恒为 [OK]，靠文字说明区别。
      mark(true, T('feat.gloss'), s.hoverGloss === true ? T('diag.on') : T('diag.offHint'));
      mark(true, T('set.transModel'), s.translateModel || T('diag.default'));
      mark(true, T('set.reasonModel'), s.reasonModel || T('diag.default'));

      // 标签页 / 内容脚本
      const tab = await getTrackedTab();
      mark(!!tab, T('diag.tab'), tab ? T('diag.isYt') : T('diag.notYt'));
      S.trackedTabId = tab ? tab.id : null;

      if (tab) {
        const st = await sendToTab('YTLB_GET_STATE');
        const alive = st && st.videoId;
        mark(
          !!alive,
          T('diag.script'),
          alive ? T('diag.alive') : T('diag.deadHint', { reason: (st && st.error) || T('st.unknownError') })
        );
        if (alive) {
          mark(
            true,
            T('diag.video'),
            T('diag.lines', { src: st.sourceLang || '?', tgt: st.targetLang || '?', n: st.transcriptLength })
          );
          // 解释用的语言可能和字幕译文不一样：原文=目标时字幕不翻译，解释照样成立
          mark(true, T('diag.explainLang'), st.explainLangUsed || T('diag.unset'));
          if (st.failReason) mark(false, T('diag.captions'), st.failReason);

          // 真正打一次悬停取词，把后端的原始错误带回来
          const g = await sendToTab('YTLB_QUICK_GLOSS', { index: Math.max(0, st.currentIndex), word: 'test' });
          if (g && g.ok && g.gloss) mark(true, T('diag.glossTest'), T('diag.glossOk', { text: g.gloss }));
          else mark(false, T('diag.glossTest'), (g && g.error) || T('diag.glossFail'));
        }
      }
    } catch (e) {
      L.push('[!!]  ' + T('diag.selfFail') + ' — ' + ((e && e.message) || e));
    }

    out.textContent = L.join('\n');
  });

  function applySticky(on) {
    $('#app').classList.toggle('sticky-current', !!on);
  }

  // 没填 Key 时提示一下，但**不强制**跳到设置页 ——
  // 字幕、笔记、生词本、导出都不需要 Key，用户完全可以只用这些。
  function updateSetupBanner() {
    const need = !S.settings || !S.settings.apiKey;
    const skipped = S.settings && S.settings.setupSkipped;
    $('#setup-banner').classList.toggle('hidden', !need || skipped);
    return need && !skipped;
  }

  // 光切到设置页是不够的：设置不在标签栏里，切过去只是标签栏高亮全灭、
  // 顶上的黄条还在，第一次用的人根本看不出发生了什么（实测就是这样漏过去的）。
  // 所以要一路带到 Key 输入框：滚过去 + 聚焦 + 闪一下。
  $('#btn-goto-settings').addEventListener('click', () => {
    switchTab('settings');
    const key = $('#set-apiKey');
    // 面板刚 display 出来，这一帧量不到位置，等下一帧再滚
    requestAnimationFrame(() => {
      key.scrollIntoView({ block: 'center' });
      key.focus();
      key.classList.add('flash');
      setTimeout(() => key.classList.remove('flash'), 1200);
    });
  });
  $('#btn-skip-setup').addEventListener('click', async () => {
    S.settings = await YTLB.saveSettings({ setupSkipped: true });
    updateSetupBanner();
  });

  // ---------------- 初始化 ----------------
  (async function init() {
    // 先定语言再填表单：applyUiLang 会把 HTML 里 data-i18n 的位置全部填上文字，
    // 顺序反了的话表单里的下拉选项会是空的
    const pre = await YTLB.getSettings();
    applyUiLang(pre.uiLang);
    await loadSettingsIntoForm();
    // 没填 Key 只是显示顶部提示条，**不再强制跳到设置页** ——
    // 不填 Key 也能用双语字幕、笔记、生词本、导出，不该把人拦在设置页上。
    updateSetupBanner();
    await refreshTrackedTab();
    setInterval(refreshBanner, 4000); // 兜底轮询，防止漏收广播消息
  })();
})();
