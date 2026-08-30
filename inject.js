// inject.js
// 以 content_scripts 的 world:"MAIN" 方式在 document_start 注入，跑在 YouTube 页面自己的 JS 环境里。
//
// 为什么需要这个文件（重要背景）：
// YouTube 的字幕接口 /api/timedtext 近年加了鉴权。直接从 ytInitialPlayerResponse 里取
// captionTracks[].baseUrl 然后 fetch，会返回 **HTTP 200 但 body 为空** —— 因为那个 baseUrl
// 缺少播放器实际请求时才会带上的 pot(PoToken) 参数。已在真实页面复现确认。
//
// 本文件的做法是不去逆向 PoToken，而是"借用"播放器自己发出的合法请求：
//   1) 在 document_start 就 hook fetch 和 XMLHttpRequest，捕获播放器请求 timedtext 的完整 URL；
//      （实测 YouTube 走的是 XHR，所以两个都必须 hook）
//   2) 把这个 URL 去掉 lang/tlang/kind 后作为"模板"。经验证 signature 覆盖的 sparams 字段里
//      不含 lang/tlang/kind/fmt，所以这几个参数可以自由替换后重新请求，依然返回 200 + 完整数据；
//   3) 如果用户没开 CC，播放器不会自己发请求 —— 这时用播放器 API 主动触发一次，
//      拿到模板后立刻把字幕设置恢复原状，不给用户留下副作用。

(function () {
  if (window.__YTLB_MAIN_WORLD__) return;
  window.__YTLB_MAIN_WORLD__ = true;

  // 按 videoId 分开存模板。
  // 必须分开存：YouTube 会预取其他视频（推荐位、上一个视频）的字幕，
  // 如果只存一份"最后捕获的"，会把别的视频的字幕当成当前视频显示 —— 实测复现过。
  var templates = Object.create(null); // videoId -> 模板 URL

  // ---------- 1) 捕获播放器自己发出的合法请求 ----------
  function noteUrl(raw) {
    try {
      if (typeof raw !== 'string' || raw.indexOf('/api/timedtext') === -1) return;
      var url = new URL(raw, location.origin);
      // 没有 pot 的是"死链"（就是从 baseUrl 直接拼出来的那种），拿了也没用
      if (!url.searchParams.get('pot')) return;
      var vid = url.searchParams.get('v');
      if (!vid) return;
      url.searchParams.delete('lang');
      url.searchParams.delete('tlang');
      url.searchParams.delete('kind');
      url.searchParams.set('fmt', 'json3');
      templates[vid] = url.toString();
    } catch (e) {
      /* 捕获失败不影响页面本身，静默 */
    }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      try {
        noteUrl(typeof input === 'string' ? input : input && input.url);
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }

  // 这两个 patch 是**故意永久挂着**的，不提供卸载。
  // YouTube 是 SPA：换视频不重新加载页面，播放器会在整个会话期间持续发字幕请求，
  // 一旦卸载，下一个视频就抓不到模板了 —— 卸载不是"更干净"，是把功能关掉。
  // 永久 patch 的真实风险是重复包裹（每注入一次多一层），这个由文件顶部的
  // __YTLB_MAIN_WORLD__ 守卫挡住了。两个 patch 都是只读透传，不改参数也不改返回值。
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      noteUrl(url);
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  // ---------- 2) 读取播放器信息（轨道列表 / 源语言 / 标题） ----------
  function getPlayerResponse() {
    // getPlayerResponse() 是播放器的实时状态，SPA 换视频后也准确；
    // ytInitialPlayerResponse 只在首屏正确，作为兜底。
    try {
      var p = document.getElementById('movie_player');
      if (p && typeof p.getPlayerResponse === 'function') {
        var pr = p.getPlayerResponse();
        if (pr && pr.videoDetails) return pr;
      }
    } catch (e) {}
    return window.ytInitialPlayerResponse || null;
  }

  function readTracks() {
    var pr = getPlayerResponse();
    var renderer = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    var raw = (renderer && renderer.captionTracks) || [];
    var tracks = raw.map(function (t) {
      return {
        languageCode: t.languageCode || '',
        kind: t.kind || '', // 'asr' = YouTube 自动生成
        name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || '',
        vssId: t.vssId || '',
        isTranslatable: t.isTranslatable !== false,
      };
    });
    return {
      videoId: (pr && pr.videoDetails && pr.videoDetails.videoId) || null,
      videoTitle: (pr && pr.videoDetails && pr.videoDetails.title) || document.title.replace(/ - YouTube$/, ''),
      // defaultAudioLanguage 不是每个视频都有，有的话是最权威的源语言信息
      defaultAudioLanguage: (pr && pr.videoDetails && pr.videoDetails.defaultAudioLanguage) || null,
      tracks: tracks,
      chapters: readChapters(),
      // 没有章节时，作者写的简介是仅次于字幕的线索
      description: (pr && pr.videoDetails && pr.videoDetails.shortDescription) || '',
    };
  }

  // 视频作者自己写的章节。这是免费的、带时间戳的、而且比 AI 概括更准
  // （实测连"Sponsors: xxx"这种广告段都标出来了），所以要优先展示。
  function readChapters() {
    try {
      var maps =
        (window.ytInitialData &&
          window.ytInitialData.playerOverlays &&
          window.ytInitialData.playerOverlays.playerOverlayRenderer &&
          window.ytInitialData.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer &&
          window.ytInitialData.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer &&
          window.ytInitialData.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar &&
          window.ytInitialData.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar
            .multiMarkersPlayerBarRenderer &&
          window.ytInitialData.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar
            .multiMarkersPlayerBarRenderer.markersMap) ||
        [];
      for (var i = 0; i < maps.length; i++) {
        if (!/CHAPTER/.test(maps[i].key || '')) continue;
        var list = (maps[i].value && maps[i].value.chapters) || [];
        if (!list.length) continue;
        return list.map(function (c) {
          var r = c.chapterRenderer || {};
          return {
            start: Math.round((r.timeRangeStartMillis || 0) / 1000),
            title: (r.title && r.title.simpleText) || '',
          };
        });
      }
    } catch (e) {}
    return [];
  }

  // ---------- 3) 主动触发一次字幕请求（用户没开 CC 时的兜底） ----------
  // 注意：不要用 player.getOption('captions','tracklist') 来挑轨道 ——
  // 视频还没起播时（playerState 为 -1）那个列表是空的，会白等 5 秒然后失败。
  // getPlayerResponse() 里的 captionTracks 在未起播时就已经是全的，实测用它触发可以立刻成功。
  function activeTrigger(videoId) {
    return new Promise(function (resolve) {
      var p = document.getElementById('movie_player');
      if (!p || typeof p.setOption !== 'function') return resolve(false);

      var info = readTracks();
      if (!info.tracks.length) return resolve(false); // 这个视频本来就没字幕
      // 用自动字幕轨道触发（几乎所有有字幕的视频都有），拿不到就用第一条
      var pick = info.tracks.filter(function (t) { return t.kind === 'asr'; })[0] || info.tracks[0];

      // 记下用户原本的字幕设置，取完数据要原样还回去
      var before = null;
      try {
        before = p.getOption('captions', 'track');
      } catch (e) {}

      try {
        p.loadModule('captions');
      } catch (e) {}
      try {
        p.setOption('captions', 'track', { languageCode: pick.languageCode, kind: pick.kind || '' });
      } catch (e) {
        return resolve(false);
      }

      var polled = 0;
      (function waitForCapture() {
        if (templates[videoId] || polled++ > 30) {
          // 无论成功与否都要恢复：原来没开字幕就传 {} 关掉
          try {
            p.setOption('captions', 'track', before && before.languageCode ? before : {});
          } catch (e) {}
          return resolve(!!templates[videoId]);
        }
        setTimeout(waitForCapture, 150);
      })();
    });
  }

  // ---------- 4) 与 content script 的桥接 ----------
  // 发送指定具体 origin、不用 '*'；接收侧只在 origin 是具体值时才比对。
  //
  // 说明白一点：这个 origin 校验**挡不住「同一个页面里的其它脚本」** —— 那种脚本的
  // e.origin 和我们完全一样。它能挡的（跨源 iframe、别的标签页）其实 e.source === window
  // 已经挡住了。所以这里是写法上的规范，不是真正的防线。
  // 真正让危害有限的是：这个桥暴露的东西页面脚本自己也拿得到，唯一的副作用
  // （activeTrigger 切一次字幕）事后会自动恢复原状。
  //
  // e.origin 为空串时不拒绝：沙箱、about:blank 这类环境下会是空的，
  // 一刀切会把字幕桥整个断掉 —— 那是拿核心功能换一个挡不住任何人的检查。
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.origin && e.origin !== location.origin) return;
    var msg = e.data;
    if (!msg || msg.type !== 'YTLB_CAP_REQ') return;

    var reqId = msg.reqId;
    var info0 = readTracks();
    // 以内容脚本传来的 videoId 为准；拿不到就用播放器当前的
    var wantVideoId = msg.videoId || info0.videoId;

    function reply(ok) {
      var info = readTracks();
      window.postMessage(
        {
          type: 'YTLB_CAP_RES',
          reqId: reqId,
          payload: {
            ok: ok,
            // 只把这个视频自己的模板给出去。绝不能退而求其次用别的视频的模板 ——
            // 那样会返回一段合法但完全无关的字幕。
            template: templates[wantVideoId] || null,
            videoId: info.videoId,
            videoTitle: info.videoTitle,
            defaultAudioLanguage: info.defaultAudioLanguage,
            tracks: info.tracks,
            chapters: info.chapters,
            description: info.description,
          },
        },
        location.origin
      );
    }

    if (templates[wantVideoId]) return reply(true);

    // 还没捕获到：先给播放器一点时间自己发（用户本来就开着 CC 的情况），再主动触发
    var waited = 0;
    (function settle() {
      if (templates[wantVideoId]) return reply(true);
      if (waited++ < 6) return setTimeout(settle, 250); // 先被动等 1.5 秒
      activeTrigger(wantVideoId).then(function (ok) {
        reply(ok);
      });
    })();
  });
})();
