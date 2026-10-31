// ==UserScript==
// @name            看漫画
// @name:en         Comic Viewer
// @namespace       local.comic.viewer
// @version         1.1.0
// @description      功能更全的漫画界面，获得更好的体验：图片预加载、目录跳转、条漫连续滚动、章节自动衔接、双页无缝拼接、日漫右起、缩放、本地缓存。界面支持中 / 英 / 日 / 韩。
// @description:en   A fuller-featured comic reader for a better reading experience: image preloading, chapter navigation, continuous webtoon scrolling, automatic chapter chaining, seamless two-page spreads, right-to-left reading, zoom, and local caching. UI available in Chinese / English / Japanese / Korean.
// @author          3Bringer
// @license         MIT
// @match           https://e-hentai.org/*
// @match           https://exhentai.org/*
// @match           https://mangacopy.com/*
// @match           https://*.mangacopy.com/*
// @match           https://nhentai.net/*
// @match           https://18comic.vip/*
// @match           https://*.18comic.vip/*
// @match           https://18comic.ink/*
// @match           https://*.18comic.ink/*
// @match           https://jmcomic-zzz.one/*
// @match           https://*.jmcomic-zzz.one/*
// @match           https://jmcomic-zzz.org/*
// @match           https://*.jmcomic-zzz.org/*
// @grant           GM_xmlhttpRequest
// @connect         *
// @run-at          document-idle
// @noframes
// ==/UserScript==

/* 用法：在该插件支持的网站的作品页或阅读页，
   点左下角按钮或按 V 打开。左右两侧点按翻页，点画面正中显示工具栏。
   快捷键：← → 翻页 · [ ] 换话 · C 目录 · S 双页 · W 条漫 · F 适配
          + - 缩放 · 0 复位 · T 明暗 · M 工具栏 · Esc 关闭          */

/* Usage: on a title page or a reader page of a supported site, click the
   button at the bottom-left corner, or press V to open. Tap the left or
   right edge of the screen to turn pages; tap the center to show the toolbar.
   Keys: ← → page · [ ] chapter · C chapters · S spread · W webtoon
         F fit · + - zoom · 0 reset · T theme · M toolbar · Esc close      */

(function () {
  'use strict';

  const VERSION = '1.3.4';
  const CFG_KEY = 'cmv:config';
  const POS_KEY = 'cmv:pos:';
  const LIST_KEY = 'cmv:list:';
  const DB_NAME = 'cmv-images';
  const STORE = 'files';
  const CONCURRENCY = 2;
  const LANG_LIST = ['zh', 'en', 'ja', 'ko'];
  const MAX_AHEAD = 8;
  const MAX_BACK = 4;
  const MAX_KEEP = 500;
  const LIST_TTL = 12 * 3600 * 1000;   // 目录缓存 12 小时

  // 系统语言：认得的就用，认不得给英语（只影响第一次打开，之后跟着设置走）
  function detectLang() {
    const list = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || ''];
    for (let i = 0; i < list.length; i++) {
      const tag = String(list[i] || '').toLowerCase();
      if (tag.indexOf('zh') === 0) return 'zh';
      if (tag.indexOf('ja') === 0) return 'ja';
      if (tag.indexOf('ko') === 0) return 'ko';
      if (tag.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }

  const DEFAULTS = {
    ahead: 4,
    back: 2,
    blobCache: true,
    fit: 'contain',
    spread: false,
    rtl: true,
    strip: false,        // 条漫模式：整章竖向连续滚动
    theme: 'dark',
    maxBlob: 120,
    launcher: true,
    tapSwap: false,
    singleStep: false,
    wheel: 'page',
    lang: detectLang()   // 界面语言：默认跟随系统，认不得用英语
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const toInt = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  const fmtSize = b => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(0, Math.round(b / 1024)) + ' KB');

  function log() {
    const args = Array.prototype.slice.call(arguments);
    console.info.apply(console, ['%c[CMV]', 'color:#0f766e;font-weight:600'].concat(args));
  }

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function abs(href, base) {
    try { return new URL(href, base || location.href).href; } catch (e) { return href; }
  }

  // 只比 origin + pathname：站点常在链接后面挂 ? 之类的追踪参数
  function bare(u) {
    try {
      const x = new URL(u, location.href);
      return x.origin + x.pathname.replace(/\/+$/, '');
    } catch (e) { return String(u).replace(/[?#].*$/, '').replace(/\/+$/, ''); }
  }

  // 比较用：站点给的链接大小写/斜杠常常对不上，忽略这些差异
  const sameUrl = (a, b) => !!a && !!b && bare(a).toLowerCase() === bare(b).toLowerCase();

  // 等一个条件成立（页面自己的脚本渲染目录需要时间）
  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = pred(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > timeout) return null;
      await sleep(200);
    }
  }

  // 给不受控的异步操作加个上限：某些环境（隐私模式、file://、库损坏）里
  // IndexedDB 既不成功也不报错，会把这个 Promise 挂到天荒地老。
  function withTimeout(p, ms, fallback) {
    return new Promise(resolve => {
      let done = false;
      const hit = v => { if (done) return; done = true; clearTimeout(t); resolve(v); };
      const t = setTimeout(() => hit(fallback), ms);
      p.then(v => hit(v), () => hit(fallback));
    });
  }

  function readCfg() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { /* 配置坏了就退回默认 */ }
    const c = Object.assign({}, DEFAULTS, raw);
    c.ahead = clamp(toInt(c.ahead, DEFAULTS.ahead), 1, MAX_AHEAD);
    c.back = clamp(toInt(c.back, DEFAULTS.back), 0, MAX_BACK);
    c.maxBlob = clamp(toInt(c.maxBlob, DEFAULTS.maxBlob), 2, MAX_KEEP);
    c.blobCache = c.blobCache !== false;
    c.spread = !!c.spread;
    c.rtl = c.rtl !== false;
    c.strip = !!c.strip;
    c.launcher = c.launcher !== false;
    c.tapSwap = !!c.tapSwap;
    c.singleStep = !!c.singleStep;
    c.wheel = c.wheel === 'zoom' ? 'zoom' : 'page';
    if (LANG_LIST.indexOf(c.lang) < 0) c.lang = detectLang();
    if (['contain', 'width', 'original'].indexOf(c.fit) < 0) c.fit = DEFAULTS.fit;
    if (['dark', 'light'].indexOf(c.theme) < 0) c.theme = DEFAULTS.theme;
    return c;
  }

  const cfg = readCfg();

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 隐私模式写不进去 */ }
  }

  const LANG = {
    zh: {
      'app.title': '看图',

      'bar.chaps': '目录 (C)',
      'bar.strip': '条漫模式：整章连续滚动 (W)',
      'bar.spread': '双页拼接 (S)',
      'bar.single': '单页步进：双页模式下每次只翻一页，用来校准奇偶配对 (1)',
      'bar.theme': '明暗 (T)',
      'bar.settings': '设置',
      'bar.close': '关闭 (Esc)',

      'fit.contain': '适应',
      'fit.width': '宽度',
      'fit.original': '原始',

      'set.lang': '界面语言',
      'set.strip': '条漫模式（整章连续滚动）',
      'set.spread': '双页模式',
      'set.rtl': '日漫模式（第二页在左）',
      'set.ahead': '预读取页数',
      'set.maxblob': '缓存页数上限',
      'set.blob': '图片缓存',
      'set.cached': '已缓存',
      'set.clear': '清空缓存',
      'set.cachedValue': '{n} 张 · {size}',
      'set.tap': '点击翻页（下一页）',
      'set.tapLeft': '左边',
      'set.tapRight': '右边',
      'set.single': '单页步进（校准）',
      'set.wheel': '鼠标滚轮',
      'set.wheelPage': '翻页',
      'set.wheelZoom': '放大',
      'set.wheelPageTip': '滚一格翻一页',
      'set.wheelZoomTip': '滚轮缩放，放大后按住左键拖动画面',
      'set.tapLeftTip': '点左侧进下一页，← 和 h 也是下一页',
      'set.tapRightTip': '点右侧进下一页，→ 和 l 也是下一页',

      'chaps.search': '搜索章节…',
      'chaps.searchN': '搜索章节（共 {n} 话）',
      'chaps.loading': '正在读取目录…',
      'chaps.empty': '没读到目录，只能按顺序往下读',
      'chaps.noMatch': '没有匹配的章节',
      'chaps.item': '第 {n} 话',

      'note.preparing': '准备中…',
      'note.opening': '正在打开 {name}…',
      'note.pageOne': '第 {n} 页',
      'note.pagesRange': '第 {a}–{b} 页',
      'note.cached': '{pages} · 本地缓存',
      'note.net': '{pages} · 网络',
      'note.stripHint': '条漫模式：滚到底会自动接下一话',
      'note.stripPage': '第 {n} 页 · 条漫',
      'note.lastPage': '已经是最后一页了',
      'note.firstPage': '已经是第一页了',
      'note.lastChapter': '已经是最后一话了',
      'note.firstChapter': '已经是第一话了',
      'note.singleOn': '单页步进：每次只翻一页',
      'note.singleOff': '双页步进：每次翻两页',
      'note.noChapters': '目录没读到：只能看这一话',
      'note.resume': '接着上次读：{name} 第 {n} 页',

      'tip.retry': '重试',
      'tip.noImage': '这一章没有读到图片',
      'tip.pageFail': '第 {n} 页图片打不开',
      'tip.pageResolve': '第 {n} 页解析不到图片地址',
      'tip.chapterFail': '{name} 没读到图片，点「重试」再试一次',

      'launch.read': '阅读',
      'launch.view': '看图',
      'launch.titleRead': '从第一话开始读（V）',
      'launch.titleView': '打开看图页（V）',
      'launch.noList': '没读到目录',
      'launch.noGallery': '没找到画廊'
    },

    en: {
      'app.title': 'Viewer',

      'bar.chaps': 'Chapters (C)',
      'bar.strip': 'Webtoon mode: scroll the whole chapter (W)',
      'bar.spread': 'Two-page spread (S)',
      'bar.single': 'Single step: one page at a time, to fix spread pairing (1)',
      'bar.theme': 'Light / dark (T)',
      'bar.settings': 'Settings',
      'bar.close': 'Close (Esc)',

      'fit.contain': 'Fit',
      'fit.width': 'Width',
      'fit.original': 'Actual',

      'set.lang': 'Language',
      'set.strip': 'Webtoon mode (scroll)',
      'set.spread': 'Two-page mode',
      'set.rtl': 'Manga order (2nd left)',
      'set.ahead': 'Preload pages',
      'set.maxblob': 'Cache limit (pages)',
      'set.blob': 'Image cache',
      'set.cached': 'Cached',
      'set.clear': 'Clear',
      'set.cachedValue': '{n} files · {size}',
      'set.tap': 'Tap to turn (next)',
      'set.tapLeft': 'Left',
      'set.tapRight': 'Right',
      'set.single': 'Single step (pairing)',
      'set.wheel': 'Mouse wheel',
      'set.wheelPage': 'Turn',
      'set.wheelZoom': 'Zoom',
      'set.wheelPageTip': 'One notch = one page',
      'set.wheelZoomTip': 'Wheel to zoom; drag to pan when zoomed',
      'set.tapLeftTip': 'Tap the left side for the next page (← / h too)',
      'set.tapRightTip': 'Tap the right side for the next page (→ / l too)',

      'chaps.search': 'Search chapters…',
      'chaps.searchN': 'Search {n} chapters…',
      'chaps.loading': 'Loading chapters…',
      'chaps.empty': 'No chapter list — read in order',
      'chaps.noMatch': 'No matching chapter',
      'chaps.item': 'Ch. {n}',

      'note.preparing': 'Preparing…',
      'note.opening': 'Opening {name}…',
      'note.pageOne': 'Page {n}',
      'note.pagesRange': 'Pages {a}–{b}',
      'note.cached': '{pages} · cached',
      'note.net': '{pages} · network',
      'note.stripHint': 'Webtoon: keep scrolling into the next chapter',
      'note.stripPage': 'Page {n} · webtoon',
      'note.lastPage': 'Already the last page',
      'note.firstPage': 'Already the first page',
      'note.lastChapter': 'Already the last chapter',
      'note.firstChapter': 'Already the first chapter',
      'note.singleOn': 'Single step: one page at a time',
      'note.singleOff': 'Spread step: two pages at a time',
      'note.noChapters': 'No chapter list: this chapter only',
      'note.resume': 'Resumed: {name}, page {n}',

      'tip.retry': 'Retry',
      'tip.noImage': 'No images in this chapter',
      'tip.pageFail': 'Page {n} failed to load',
      'tip.pageResolve': 'Cannot resolve the image for page {n}',
      'tip.chapterFail': '{name}: no images — try Retry',

      'launch.read': 'Read',
      'launch.view': 'View',
      'launch.titleRead': 'Read from chapter 1 (V)',
      'launch.titleView': 'Open the viewer (V)',
      'launch.noList': 'No chapter list',
      'launch.noGallery': 'Gallery not found'
    },

    ja: {
      'app.title': 'ビューア',

      'bar.chaps': '目次 (C)',
      'bar.strip': '縦読みモード：章を連続スクロール (W)',
      'bar.spread': '見開き (S)',
      'bar.single': '1ページ送り：見開きの組み合わせ調整用 (1)',
      'bar.theme': '明暗 (T)',
      'bar.settings': '設定',
      'bar.close': '閉じる (Esc)',

      'fit.contain': 'フィット',
      'fit.width': '幅',
      'fit.original': '原寸',

      'set.lang': '表示言語',
      'set.strip': '縦読みモード（章を連続）',
      'set.spread': '見開きモード',
      'set.rtl': '右開き（2ページ目が左）',
      'set.ahead': '先読みページ数',
      'set.maxblob': 'キャッシュ上限',
      'set.blob': '画像キャッシュ',
      'set.cached': 'キャッシュ済み',
      'set.clear': 'クリア',
      'set.cachedValue': '{n} 枚 · {size}',
      'set.tap': 'タップで送り（次へ）',
      'set.tapLeft': '左',
      'set.tapRight': '右',
      'set.single': '1ページ送り（調整）',
      'set.wheel': 'マウスホイール',
      'set.wheelPage': 'ページ送り',
      'set.wheelZoom': '拡大',
      'set.wheelPageTip': '1ノッチで1ページ',
      'set.wheelZoomTip': 'ホイールで拡大、拡大後はドラッグで移動',
      'set.tapLeftTip': '左タップで次へ（← / h も可）',
      'set.tapRightTip': '右タップで次へ（→ / l も可）',

      'chaps.search': '話を検索…',
      'chaps.searchN': '話を検索（全 {n} 話）',
      'chaps.loading': '目次を読み込み中…',
      'chaps.empty': '目次を取得できません',
      'chaps.noMatch': '一致する話がありません',
      'chaps.item': '第{n}話',

      'note.preparing': '準備中…',
      'note.opening': '{name} を開いています…',
      'note.pageOne': '{n}ページ',
      'note.pagesRange': '{a}–{b}ページ',
      'note.cached': '{pages} · キャッシュ',
      'note.net': '{pages} · ネット',
      'note.stripHint': '縦読み：最後までスクロールすると次の話へ',
      'note.stripPage': '{n}ページ · 縦読み',
      'note.lastPage': '最後のページです',
      'note.firstPage': '最初のページです',
      'note.lastChapter': '最後の話です',
      'note.firstChapter': '最初の話です',
      'note.singleOn': '1ページ送り：1ページずつ',
      'note.singleOff': '見開き送り：2ページずつ',
      'note.noChapters': '目次なし：この話のみ',
      'note.resume': '前回の続き：{name} {n}ページ',

      'tip.retry': '再試行',
      'tip.noImage': 'この話に画像がありません',
      'tip.pageFail': '{n}ページ目を読み込めません',
      'tip.pageResolve': '{n}ページ目の画像URLを取得できません',
      'tip.chapterFail': '{name}：画像なし。「再試行」を',

      'launch.read': '読む',
      'launch.view': '見る',
      'launch.titleRead': '第1話から読む（V）',
      'launch.titleView': 'ビューアを開く（V）',
      'launch.noList': '目次なし',
      'launch.noGallery': 'ギャラリーが見つかりません'
    },

    ko: {
      'app.title': '뷰어',

      'bar.chaps': '목차 (C)',
      'bar.strip': '세로 읽기: 챕터 전체 연속 스크롤 (W)',
      'bar.spread': '두 페이지 (S)',
      'bar.single': '한 장씩: 펼침 짝 맞춤용 (1)',
      'bar.theme': '밝기 (T)',
      'bar.settings': '설정',
      'bar.close': '닫기 (Esc)',

      'fit.contain': '맞춤',
      'fit.width': '너비',
      'fit.original': '원본',

      'set.lang': '언어',
      'set.strip': '세로 읽기 (챕터 연속)',
      'set.spread': '두 페이지 모드',
      'set.rtl': '일본식 (2쪽이 왼쪽)',
      'set.ahead': '미리 읽기',
      'set.maxblob': '캐시 상한',
      'set.blob': '이미지 캐시',
      'set.cached': '캐시됨',
      'set.clear': '비우기',
      'set.cachedValue': '{n}장 · {size}',
      'set.tap': '탭으로 넘김 (다음)',
      'set.tapLeft': '왼쪽',
      'set.tapRight': '오른쪽',
      'set.single': '한 장씩 (짝 맞춤)',
      'set.wheel': '마우스 휠',
      'set.wheelPage': '페이지 넘김',
      'set.wheelZoom': '확대',
      'set.wheelPageTip': '한 칸 = 한 페이지',
      'set.wheelZoomTip': '휠로 확대, 확대 후 드래그로 이동',
      'set.tapLeftTip': '왼쪽 탭 = 다음 (← / h)',
      'set.tapRightTip': '오른쪽 탭 = 다음 (→ / l)',

      'chaps.search': '챕터 검색…',
      'chaps.searchN': '챕터 검색 (총 {n}화)',
      'chaps.loading': '목차 불러오는 중…',
      'chaps.empty': '목차를 못 읽었습니다',
      'chaps.noMatch': '일치하는 챕터 없음',
      'chaps.item': '{n}화',

      'note.preparing': '준비 중…',
      'note.opening': '{name} 여는 중…',
      'note.pageOne': '{n}페이지',
      'note.pagesRange': '{a}–{b}페이지',
      'note.cached': '{pages} · 캐시',
      'note.net': '{pages} · 네트워크',
      'note.stripHint': '세로 읽기: 끝까지 내리면 다음 화로',
      'note.stripPage': '{n}페이지 · 세로 읽기',
      'note.lastPage': '마지막 페이지입니다',
      'note.firstPage': '첫 페이지입니다',
      'note.lastChapter': '마지막 화입니다',
      'note.firstChapter': '첫 화입니다',
      'note.singleOn': '한 장씩 넘기기',
      'note.singleOff': '두 장씩 넘기기',
      'note.noChapters': '목차 없음: 이 화만',
      'note.resume': '이어보기: {name} {n}페이지',

      'tip.retry': '다시 시도',
      'tip.noImage': '이 화에 이미지가 없습니다',
      'tip.pageFail': '{n}페이지를 못 엽니다',
      'tip.pageResolve': '{n}페이지 이미지 주소를 못 찾음',
      'tip.chapterFail': '{name}: 이미지 없음 — 다시 시도',

      'launch.read': '읽기',
      'launch.view': '보기',
      'launch.titleRead': '1화부터 읽기 (V)',
      'launch.titleView': '뷰어 열기 (V)',
      'launch.noList': '목차 없음',
      'launch.noGallery': '갤러리 없음'
    }
  };

  // 取一条文案；{name} 这种占位符由 vars 填。查不到就退回中文。
  function msg(key, vars) {
    const pack = LANG[cfg.lang] || LANG.zh;
    let out = pack[key];
    if (out == null) out = LANG.zh[key];
    if (out == null) return key;
    if (vars) {
      out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
    }
    return out;
  }

  // 把模板里 data-i18n* 标记的文字换成当前语言
  function applyLang() {
    const root = view.el;
    if (!root) return;

    root.setAttribute('lang', cfg.lang === 'zh' ? 'zh-CN' : cfg.lang);

    let list = root.querySelectorAll('[data-i18n]');
    for (let i = 0; i < list.length; i++) list[i].textContent = msg(list[i].dataset.i18n);

    list = root.querySelectorAll('[data-i18n-title]');
    for (let i = 0; i < list.length; i++) list[i].title = msg(list[i].dataset.i18nTitle);

    list = root.querySelectorAll('[data-i18n-ph]');
    for (let i = 0; i < list.length; i++) list[i].placeholder = msg(list[i].dataset.i18nPh);

    syncLauncherText();
    view.chapSig = '';      // 目录里的提示文字要跟着换
    render();
  }

  // 图片占位符 / 广告图，这些不能当成正文
  const BAD_IMG = /(loading\.(jpe?g|png|gif)|blank\.gif|spacer|placeholder|logo|favicon|^data:|^about:|^javascript:)/i;

  function pickSrc(img, base) {
    const cand = img.getAttribute('data-src')
      || img.getAttribute('data-original')
      || img.getAttribute('data-lazy-src')
      || img.getAttribute('src')
      || '';
    if (!cand || BAD_IMG.test(cand)) return null;
    return abs(cand, base);
  }

  // 图片地址不是明文写在 HTML 里的：页面内联了
  //   var cct = '16 字符密钥';
  //   var contentKey = '16 字符 IV' + 'hex 密文';
  // 用 AES-128-CBC + PKCS7 解出来，是一个 [{url}, ...] 数组。
  // 浏览器自带 WebCrypto，不用再拖一份 CryptoJS 进来。
  async function aesDecryptJson(keyStr, payload) {
    const te = new TextEncoder();
    const keyBytes = te.encode(keyStr);
    if (keyBytes.length !== 16) throw new Error('密钥不是 16 字节');

    const iv = te.encode(payload.slice(0, 16));
    if (iv.length !== 16) throw new Error('IV 不是 16 字节');

    const hex = payload.slice(16).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length < 32 || hex.length % 2) throw new Error('密文长度异常');

    const ct = new Uint8Array(hex.length / 2);
    for (let i = 0; i < ct.length; i++) ct[i] = parseInt(hex.substr(i * 2, 2), 16);

    if (!(window.crypto && crypto.subtle)) throw new Error('当前环境没有 WebCrypto');
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // 密文的两个变量：先看运行时全局（阅读页会被站点脚本写入），
  // 再从内联 <script> 文本里正则捞（fetch 回来的文档没有 window）。
  function readKeys(doc) {
    let cct = '';
    let ck = '';
    const g = doc.defaultView;
    if (g) {
      try {
        if (typeof g.cct === 'string') cct = g.cct;
        if (typeof g.contentKey === 'string') ck = g.contentKey;
      } catch (e) { /* 跨域文档读不了，忽略 */ }
    }
    if (!cct || !ck) {
      const list = doc.querySelectorAll('script:not([src])');
      for (let i = 0; i < list.length; i++) {
        const t = list[i].textContent || '';
        if (!t || t.indexOf('contentKey') < 0) continue;
        if (!cct) {
          const m = t.match(/cct\s*=\s*['"]([^'"]*)['"]/);
          if (m) cct = m[1];
        }
        if (!ck) {
          const m = t.match(/contentKey\s*=\s*['"]([^'"]*)['"]/);
          if (m) ck = m[1];
        }
      }
    }
    return { cct, ck };
  }

  // 把页面里的内联密文解成图片地址数组；没有密文、或者解不开，都返回空数组
  // （拷贝漫画专用，别的站点适配器不会用到）
  async function inlineImages(doc, base) {
    const keys = readKeys(doc);
    if (!keys.cct || !keys.ck) return [];

    try {
      const arr = await aesDecryptJson(keys.cct, keys.ck);
      if (!Array.isArray(arr)) return [];

      const out = [];
      const seen = new Set();
      for (let i = 0; i < arr.length; i++) {
        const raw = arr[i] && arr[i].url;
        if (!raw) continue;
        const u = abs(raw, base);
        if (seen.has(u)) continue;
        seen.add(u);
        out.push(u);
      }
      return out;
    } catch (e) {
      log('解密失败：' + (e && e.message));
      return [];
    }
  }

  const MANGACOPY = {
    id: 'mangacopy',
    name: '拷贝漫画',
    host: /(^|\.)mangacopy\.com$/i,

    isDetail(pathname) {
      return /^\/comic\/[^/]+\/?$/.test(pathname);
    },

    isChapter(pathname) {
      return /^\/comic\/[^/]+\/chapter\/[^/]+\/?$/.test(pathname);
    },

    detailUrlOf(url) {
      const m = url.pathname.match(/^(\/comic\/[^/]+)(\/|$)/);
      return m ? url.origin + m[1] : null;
    },

    // 作品标题：详情页有 h6[title]，阅读页只有 <title> 可以拿
    bookTitle(doc) {
      const el = doc.querySelector('.comicParticulars-title-right h6[title]')
        || doc.querySelector('.comicParticulars-title-right h6');
      if (el) {
        const t = (el.getAttribute('title') || el.textContent || '').trim();
        if (t) return t;
      }
      const raw = (doc.title || '').split(/[-–|]/)[0].trim();
      return raw.replace(/漫画$/, '').trim();
    },

    // 目录页：链接全在 .upLoop 里。注意站点把目录分成了几个分组
    // （默認 / 單行本 / 彩頁…），每个分组又有「全部 / 話 / 卷 / 番外」几个标签，
    // 标签之间是同一批链接的重复。取第一个分组的第一栏（默認 · 全部）当目录；
    // 顶部「更新內容」那条指向最新一话，不属于目录，跳过。
    chaptersFromDoc(doc, detailUrl) {
      const base = detailUrl || location.href;
      let prefix;
      try { prefix = new URL(base).origin + new URL(base).pathname.replace(/\/+$/, '') + '/chapter/'; }
      catch (e) { return []; }

      const scope = doc.querySelector('.upLoop') || doc;
      const panes = scope.querySelectorAll('.tab-content .tab-pane');
      const root = panes.length ? panes[0] : scope;

      const as = root.querySelectorAll('a[href*="/chapter/"]');
      const out = [];
      const seen = new Set();

      for (let i = 0; i < as.length; i++) {
        if (as[i].closest('.table-default-right')) continue;
        const u = bare(abs(as[i].getAttribute('href'), base));
        if (!u || u.indexOf(prefix) !== 0) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        const t = (as[i].getAttribute('title') || as[i].textContent || '').replace(/\s+/g, ' ').trim();
        out.push({ title: t || ('第 ' + (out.length + 1) + ' 话'), url: u });
      }
      return out;
    },

    // 阅读页：ul.comicContent-list > li > img[data-src]
    imagesFromDoc(doc, baseUrl) {
      const list = doc.querySelectorAll('ul.comicContent-list img');
      const out = [];
      const seen = new Set();
      for (let i = 0; i < list.length; i++) {
        const u = pickSrc(list[i], baseUrl);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        out.push(u);
      }
      return out;
    },

    async imagesFromHtml(html, url) {
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // 优先解密：密文里才是整章；HTML 里零星几张只是服务端顺手渲染的前几张
      const viaKeys = await inlineImages(doc, url);
      if (viaKeys.length) return viaKeys;

      return this.imagesFromDoc(doc, url);
    },

    // 本章页数（阅读页右上角的 1 / 11）
    pageCount(doc) {
      const el = doc.querySelector('.comicCount');
      const n = el ? parseInt(el.textContent, 10) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
  };

  // /s/<hash>/<gid>-<页序号>；页序号从 1 开始。规范化的写法要和
  // 预加载脚本一致（小写、无尾斜杠），否则 sessionStorage 的键对不上。
  function ehPageInfo(href, base) {
    let url;
    try { url = new URL(href, base || location.href); } catch (e) { return null; }
    if (!/(^|\.)(e-hentai|exhentai)\.org$/i.test(url.hostname)) return null;
    const m = url.pathname.match(/^\/s\/([0-9a-f]{10})\/(\d+)-(\d+)\/?$/i);
    if (!m) return null;
    return {
      gid: m[2],
      page: parseInt(m[3], 10),
      url: url.origin + '/s/' + m[1].toLowerCase() + '/' + m[2] + '-' + m[3]
    };
  }

  const EHMETA_KEY = 'ehp:meta:';        // 预加载脚本的键名，别改
  const EH_DB = 'ehp-images';            // 预加载脚本的图片库，别改
  const ehCursor = new Map();            // 画廊地址 -> 下一个要取的缩略图分页

  // 预加载脚本写下的「页 -> {img, next}」；命中就能省一次请求
  function readEhMeta(pageUrl) {
    try {
      const raw = sessionStorage.getItem(EHMETA_KEY + pageUrl);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && typeof v.img === 'string' && v.img ? v : null;
    } catch (e) { return null; }
  }

  function writeEhMeta(pageUrl, img, next) {
    try {
      sessionStorage.setItem(EHMETA_KEY + pageUrl, JSON.stringify({ img: img || '', next: next || null }));
    } catch (e) { /* 配额满了不影响阅读 */ }
  }

  // 这一页记下的图片地址可能是过期的（链接带时效），重试时要一起清掉，
  // 否则永远拿到同一个打不开的地址
  function forgetEhMeta(pageUrl) {
    try { sessionStorage.removeItem(EHMETA_KEY + pageUrl); } catch (e) { /* ignore */ }
  }

  // 从预加载脚本的图片库里借已经下好的字节（只读，不建表、不抢版本）
  function borrowEhImage(imgUrl) {
    return new Promise(resolve => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      let req;
      try { req = indexedDB.open(EH_DB); } catch (e) { resolve(null); return; }

      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const d = req.result;
        try {
          if (!d.objectStoreNames.contains('files')) { d.close(); resolve(null); return; }
          const g = d.transaction('files', 'readonly').objectStore('files').get(imgUrl);
          g.onsuccess = () => { const r = g.result; d.close(); resolve((r && r.blob) || null); };
          g.onerror = () => { d.close(); resolve(null); };
        } catch (e) { try { d.close(); } catch (e2) { /* ignore */ } resolve(null); }
      };
    });
  }

  // 把预加载脚本图片库里坏掉的那一份删掉。只是缓存，删了它自己会重下。
  function dropEhImage(imgUrl) {
    return new Promise(resolve => {
      if (typeof indexedDB === 'undefined') { resolve(false); return; }
      let req;
      try { req = indexedDB.open(EH_DB); } catch (e) { resolve(false); return; }

      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        const d = req.result;
        try {
          if (!d.objectStoreNames.contains('files')) { d.close(); resolve(false); return; }
          const tx = d.transaction('files', 'readwrite');
          tx.objectStore('files').delete(imgUrl);
          tx.oncomplete = () => { d.close(); resolve(true); };
          tx.onerror = () => { d.close(); resolve(false); };
          tx.onabort = () => { d.close(); resolve(false); };
        } catch (e) { try { d.close(); } catch (e2) { /* ignore */ } resolve(false); }
      };
    });
  }

  const EHENTAI = {
    id: 'ehentai',
    name: 'E-Hentai',
    host: /(^|\.)(e-hentai|exhentai)\.org$/i,
    single: true,        // 一个画廊就是一话，没有章节可选

    isDetail(pathname) {
      return /^\/g\/\d+\/[0-9a-f]{10}\/?$/i.test(pathname);
    },

    isChapter(pathname) {
      return /^\/s\/[0-9a-f]{10}\/\d+-\d+\/?$/i.test(pathname);
    },

    // /s/ 页上没有 gid→hash 的映射，只能从当前文档里的「Gallery」链接摸回去
    detailUrlOf(url, doc) {
      const m = url.pathname.match(/^\/s\/[0-9a-f]{10}\/(\d+)-(\d+)\/?$/i);
      if (!m) return null;

      const gid = m[1];
      const d = doc || document;
      const as = d.querySelectorAll('a[href*="/g/"]');
      for (let i = 0; i < as.length; i++) {
        const hit = (as[i].getAttribute('href') || '').match(/\/g\/(\d+)\/([0-9a-f]{10})/i);
        if (hit && hit[1] === gid) return url.origin + '/g/' + hit[1] + '/' + hit[2].toLowerCase() + '/';
      }
      return null;
    },

    // 从阅读页进画廊时，直接把页码当起始位置
    pageIndexOf(url) {
      const m = url.pathname.match(/^\/s\/[0-9a-f]{10}\/\d+-(\d+)\/?$/i);
      return m ? Math.max(0, parseInt(m[1], 10) - 1) : 0;
    },

    chaptersFromDoc(doc, detailUrl) {
      if (!detailUrl) return [];
      return [{ title: this.bookTitle(doc) || '画廊', url: bare(detailUrl) }];
    },

    bookTitle(doc) {
      const el = doc.querySelector('#gn') || doc.querySelector('#gj') || doc.querySelector('h1');
      if (el && (el.textContent || '').trim()) return el.textContent.trim();

      // 阅读页上标题在「Gallery」那个链接里
      const back = doc.querySelector('a[href*="/g/"]');
      if (back && (back.textContent || '').trim()) return back.textContent.trim();

      return (doc.title || '').split('-')[0].trim();
    },

    // 缩略图链接 → 页面地址，按页码排序去重
    imagesFromDoc(doc, baseUrl) {
      const as = doc.querySelectorAll('a[href*="/s/"]');
      const byPage = new Map();
      for (let i = 0; i < as.length; i++) {
        const info = ehPageInfo(as[i].getAttribute('href'), baseUrl);
        if (!info) continue;
        if (!byPage.has(info.page)) byPage.set(info.page, info.url);
      }
      return Array.from(byPage.keys()).sort((a, b) => a - b).map(p => byPage.get(p));
    },

    async imagesFromHtml(html, url) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { items: this.imagesFromDoc(doc, url), total: this.pageTotal(doc) };
    },

    // 画廊信息栏里的「Length: N pages」
    pageTotal(doc) {
      const gdd = doc.querySelector('#gdd');
      const m = gdd ? gdd.textContent.match(/Length:?\s*([\d,]+)\s*pages/i) : null;
      return m ? parseInt(m[1].replace(/,/g, ''), 10) || 0 : 0;
    },

    // 页面地址 → 图片地址：先问预加载脚本的缓存，没有再抓这一页
    async resolveItem(pageUrl) {
      // 这一页刚被判过死刑（重试过）：别再信 sessionStorage 里那份地址，
      // 预加载脚本很可能又把同一条过期链接原样写回去了
      const cached = badImg.has(bare(pageUrl)) ? null : readEhMeta(pageUrl);
      if (cached && cached.img) return abs(cached.img, pageUrl);

      const html = await fetchText(pageUrl);
      const doc = new DOMParser().parseFromString(html, 'text/html');

      let img = doc.querySelector('#img');
      let src = img && (img.getAttribute('src') || img.getAttribute('data-src'));

      if (!src) {
        // 版面变了就退而求其次：找最像正文的那张
        let best = null;
        let bestScore = 0;
        const imgs = doc.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
          const s = imgs[i].getAttribute('src') || '';
          if (!s || /^data:|l\.png|favicon|logo|spacer|blank\.gif/i.test(s)) continue;
          let score = 0;
          if (/hath\.network/i.test(s)) score += 500;
          if (/\/h\/[0-9a-f]+\//i.test(s)) score += 120;
          if (score > bestScore) { bestScore = score; best = s; }
        }
        src = best;
      }
      if (!src) return null;

      const full = abs(src, pageUrl);
      const nextEl = doc.querySelector('#next');
      writeEhMeta(pageUrl, full, nextEl ? abs(nextEl.getAttribute('href'), pageUrl) : null);
      return full;
    },

    // 缩略图分页：?p=1,2,3… 每次补一批
    async extendChapter(chUrl) {
      const key = bare(chUrl);
      let st = ehCursor.get(key);
      if (!st) { st = { p: 1 }; ehCursor.set(key, st); }

      const sep = chUrl.indexOf('?') >= 0 ? '&' : '?';
      const html = await fetchText(chUrl.replace(/[?#].*$/, '') + sep + 'p=' + st.p);
      st.p++;

      const doc = new DOMParser().parseFromString(html, 'text/html');
      return this.imagesFromDoc(doc, chUrl);
    },

    // 图片字节：借预加载脚本下好的，省一次下载
    borrowImage(imgUrl) {
      return borrowEhImage(imgUrl);
    }
  };


  const NH_EXT = { j: 'jpg', p: 'png', g: 'gif', w: 'webp' };

  // /g/123 或 /g/123/4 → '123'；不是 nhentai 的地址返回 null
  function nhId(href, base) {
    let url;
    try { url = new URL(href, base || location.href); } catch (e) { return null; }
    if (!/(^|\.)nhentai\.net$/i.test(url.hostname)) return null;
    const m = url.pathname.match(/^\/g\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  function nhImageUrl(mediaId, n, t) {
    return 'https://i.nhentai.net/galleries/' + mediaId + '/' + n + '.' + (NH_EXT[t] || 'jpg');
  }

  async function nhApi(id) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch('https://nhentai.net/api/gallery/' + id, {
        credentials: 'include',
        signal: ctl.signal,
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const NHENTAI = {
    id: 'nhentai',
    name: 'nhentai',
    host: /(^|\.)nhentai\.net$/i,
    single: true,        // 一个画廊就是一话，没有章节可选

    isDetail(pathname) {
      return /^\/g\/\d+\/?$/.test(pathname);
    },

    isChapter(pathname) {
      return /^\/g\/\d+\/\d+\/?$/.test(pathname);
    },

    detailUrlOf(url) {
      const id = nhId(url.href);
      return id ? 'https://nhentai.net/g/' + id + '/' : null;
    },

    // 从阅读页 /g/123/4/ 进来，直接从第 4 页开始
    pageIndexOf(url) {
      const m = url.pathname.match(/^\/g\/\d+\/(\d+)\/?$/);
      return m ? Math.max(0, parseInt(m[1], 10) - 1) : 0;
    },

    chaptersFromDoc(doc, detailUrl) {
      if (!detailUrl) return [];
      return [{ title: this.bookTitle(doc) || '画廊', url: bare(detailUrl) }];
    },

    bookTitle(doc) {
      const el = doc.querySelector('h1.title .pretty')
        || doc.querySelector('h1.title')
        || doc.querySelector('#info h1');
      if (el && (el.textContent || '').trim()) return el.textContent.trim();

      // 阅读页上没有标题元素，只能从 <title> 里剥：
      // 「标题 | nhentai」或者「Page 3 | 标题 | nhentai」
      return String(doc.title || '')
        .replace(/\s*[|｜–—-]\s*nhentai.*$/i, '')
        .replace(/^page\s*\d+\s*[|｜–—-]\s*/i, '')
        .trim();
    },

    // 一次拿全章（引擎的 fastImages 会优先用它）
    async fetchImages(chUrl) {
      const id = nhId(chUrl);
      if (!id) return null;

      const data = await nhApi(id);
      const pages = data && data.images && data.images.pages;
      if (!data || !data.media_id || !pages || !pages.length) return null;

      const images = [];
      for (let i = 0; i < pages.length; i++) {
        images.push(nhImageUrl(data.media_id, i + 1, pages[i] && pages[i].t));
      }
      return { images: images, total: data.num_pages || images.length, how: '接口' };
    },

    // 兜底：阅读页只有当前这一张；画廊页把缩略图链接换成「页面地址」
    imagesFromDoc(doc, baseUrl) {
      const img = doc.querySelector('#image') || doc.querySelector('#image-container img');
      const src = img && (img.getAttribute('src') || img.getAttribute('data-src'));
      if (src) return [abs(src, baseUrl)];

      const id = nhId(baseUrl);
      if (!id) return [];

      const re = new RegExp('^/g/' + id + '/(\\d+)/?$');
      const as = doc.querySelectorAll('a[href*="/g/"]');
      const byPage = new Map();
      for (let i = 0; i < as.length; i++) {
        const m = (as[i].getAttribute('href') || '').match(re);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (n > 0 && !byPage.has(n)) byPage.set(n, 'https://nhentai.net/g/' + id + '/' + n + '/');
      }
      return Array.from(byPage.keys()).sort((a, b) => a - b).map(n => byPage.get(n));
    },

    async imagesFromHtml(html, url) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { items: this.imagesFromDoc(doc, url), total: 0 };
    },

    // 页面地址 → 图片地址。本来就是图片地址的直接放行（大多数情况走这里）
    async resolveItem(raw) {
      if (!raw) return null;

      let url;
      try { url = new URL(raw, location.href); } catch (e) { return raw; }
      if (!/^\/g\/\d+\/\d+\/?$/.test(url.pathname)) return raw;

      const html = await fetchText(raw);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const img = doc.querySelector('#image') || doc.querySelector('#image-container img');
      const src = img && (img.getAttribute('src') || img.getAttribute('data-src'));
      return src ? abs(src, raw) : null;
    },

    // iframe 兜底时，什么算「渲染好了」
    frameReady(doc) {
      return !!(doc.querySelector('#image') || doc.querySelector('.thumb-container'));
    },

    // 图片有好几个主机（i1~i4，i 是调度用的别名）。某个节点连不上时
    // （典型报错 ERR_CONNECTION_CLOSED，多半是代理规则只放行了 i 或者节点挂了），
    // 换一个编号主机再试。最多给 3 个候选，免得全挂的时候卡太久。
    fallbacks(imgUrl) {
      const m = String(imgUrl).match(/^https?:\/\/(i\d*)\.nhentai\.net\/(.+)$/i);
      if (!m) return [];

      const path = m[2];
      const out = [];
      const add = u => { if (u !== imgUrl && out.indexOf(u) < 0) out.push(u); };

      for (let n = 1; n <= 4; n++) add('https://i' + n + '.nhentai.net/' + path);
      add('https://i.nhentai.net/' + path);      // 调度主机，可能重新分配节点

      return out.slice(0, 3);
    }
  };


  // 18comic 的镜像：只影响 host 匹配，路径规则都一样
  const JM_HOST = /(^|\.)(18comic|jmcomic-zzz)\.[a-z]+$/i;

  const JM_SCRAMBLE_DEFAULT = 220980;   // 页面里读不到 scramble_id 时按这个算

  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const MD5_K = (() => {
    const k = new Array(64);
    for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    return k;
  })();

  function md5Hex(str) {
    const enc = new TextEncoder().encode(String(str));
    const bytes = [];
    for (let i = 0; i < enc.length; i++) bytes.push(enc[i]);

    const bitLen = enc.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 4; i++) bytes.push((bitLen >>> (i * 8)) & 0xFF);
    for (let i = 0; i < 4; i++) bytes.push(0);

    let a0 = 0x67452301 | 0;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476 | 0;

    for (let off = 0; off < bytes.length; off += 64) {
      const x = new Array(16);
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        x[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
      }

      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }

        const tmp = d;
        d = c;
        c = b;
        const sum = (a + f + MD5_K[i] + x[g]) | 0;
        const s = MD5_S[i];
        b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
        a = tmp;
      }

      a0 = (a0 + a) | 0;
      b0 = (b0 + b) | 0;
      c0 = (c0 + c) | 0;
      d0 = (d0 + d) | 0;
    }

    let out = '';
    [a0, b0, c0, d0].forEach(n => {
      for (let i = 0; i < 4; i++) out += ((n >>> (i * 8)) & 0xFF).toString(16).padStart(2, '0');
    });
    return out;
  }

  // 这张图被切成了几段（0 = 没打乱）
  function jmSplitNum(aid, scrambleId, filename) {
    aid = parseInt(aid, 10) || 0;
    scrambleId = parseInt(scrambleId, 10) || 0;
    if (!aid) return 0;
    if (aid < scrambleId) return 0;
    if (aid < 268850) return 10;

    const x = aid < 421926 ? 10 : 8;
    const h = md5Hex(String(aid) + filename);
    return (h.charCodeAt(h.length - 1) % x) * 2 + 2;
  }

  // 图片地址 → 文件名（去掉扩展名和查询串），MD5 用的就是它
  function jmFileName(url) {
    const s = String(url).split('#')[0].split('?')[0];
    const last = s.split('/').pop() || '';
    return last.replace(/\.[a-z0-9]+$/i, '');
  }

  // 把打乱的图还原：切成 num 段横条，从下往上搬到上往下
  async function jmUnscramble(blob, num) {
    if (!num || num < 2) return blob;
    if (typeof createImageBitmap !== 'function') return blob;

    let bmp;
    try { bmp = await createImageBitmap(blob); } catch (e) { return blob; }

    const w = bmp.width;
    const h = bmp.height;
    const move = Math.floor(h / num);
    const over = h % num;

    if (!w || !move) { if (bmp.close) bmp.close(); return blob; }

    // 页面图不会这么小。这么小的多半是被误当成页的广告 / 占位图，
    // 它本来就没打乱，硬还原只会切成错位的花图——原样返回。
    if (w < 300 || h < 300) { if (bmp.close) bmp.close(); return blob; }

    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');

    for (let i = 0; i < num; i++) {
      const ySrc = h - move * (i + 1) - over;
      let yDst = move * i;
      let hh = move;
      if (i === 0) hh += over;      // 第一段吸收余数
      else yDst += over;            // 后面的整体下移
      ctx.drawImage(bmp, 0, ySrc, w, hh, 0, yDst, w, hh);
    }
    if (bmp.close) bmp.close();

    return new Promise(resolve => {
      if (typeof cv.toBlob !== 'function') { resolve(blob); return; }
      cv.toBlob(b => resolve(b || blob), 'image/jpeg', 0.92);
    });
  }

  const jmSplit = new Map();     // 图片地址 → 分割数

  const JMCOMIC = {
    id: 'jmcomic',
    name: '18comic',
    host: JM_HOST,

    // 作品页地址带标题尾巴：/album/1482983/标题 → 后面的路径段不能当成不存在
    isDetail(pathname) {
      return /^\/album\/\d+(?:\/|$)/i.test(pathname);
    },

    // 阅读页同理，/photo/300001/ 或 /photo/300001/标题 都认
    isChapter(pathname) {
      return /^\/photo\/\d+(?:\/|$)/i.test(pathname);
    },

    // 归一作品页地址：去掉标题尾巴，进度和目录缓存的键才稳定
    normDetail(url) {
      const id = (String(url).match(/\/album\/(\d+)/) || [])[1];
      return id ? url.origin + '/album/' + id + '/' : null;
    },

    // 阅读页 → 作品页。优先用阅读页脚本里的 album_id（站上叫 series_id），
    // 拿不到再找页面上的回作品链接（保留原地址，可能带标题尾巴）
    detailUrlOf(url, doc) {
      const d = doc || document;

      const scripts = d.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const m = (scripts[i].textContent || '').match(/var\s+series_id\s*=\s*(\d+)/);
        if (m && parseInt(m[1], 10) > 0) return url.origin + '/album/' + m[1] + '/';
      }

      const as = d.querySelectorAll('a[href*="/album/"]');
      for (let i = 0; i < as.length; i++) {
        const href = as[i].getAttribute('href') || '';
        if (/\/album\/\d+/.test(href)) return abs(href, url.href);
      }
      return null;
    },

    bookTitle(doc) {
      const el = doc.querySelector('#book-name')
        || doc.querySelector('.book-title')
        || doc.querySelector('.panel-heading h2')
        || doc.querySelector('h1');
      if (el && (el.textContent || '').trim()) return el.textContent.trim();

      // 阅读页的 <title> 是「标题 | 18comic」或「第 N 页 | 标题 | 18comic」
      const t = String(doc.title || '')
        .replace(/\s*[|｜]\s*18comic.*$/i, '')
        .replace(/^第\s*\d+\s*[页頁]\s*[|｜]\s*/, '')
        .trim();
      return t;
    },

    // 作品页：章节条目上带 data-album="{阅读页编号}"（不是 /photo/ 链接），
    // 单话作品则是「开始阅读」按钮，两种都收。按 DOM 顺序就是阅读顺序。
    //
    // ⚠️ 注意：第一话的编号往往就等于作品号（连载作品建号时第一话和作品
    // 共用一个号），所以绝对不能把「data-album === 作品号」当成非章节条目
    // 跳过——那样会把第一话整个删掉，只剩第二话开始。
    chaptersFromDoc(doc, detailUrl) {
      const out = [];
      const seen = new Set();
      const base = detailUrl || location.href;

      const push = (id, name) => {
        if (!id || !/^\d+$/.test(String(id)) || seen.has(String(id))) return;
        seen.add(String(id));
        out.push({
          title: name || ('第 ' + (out.length + 1) + ' 话'),
          url: abs('/photo/' + id + '/', base)
        });
      };

      // 主要来源：章节条目
      const eps = doc.querySelectorAll('[data-album]');
      for (let i = 0; i < eps.length; i++) {
        push(eps[i].getAttribute('data-album'),
             (eps[i].textContent || '').replace(/\s+/g, ' ').trim());
      }

      // 兼容：直接的 /photo/ 链接（旧版布局、页脚的「开始阅读」）
      const as = doc.querySelectorAll('a[href*="/photo/"]');
      for (let i = 0; i < as.length; i++) {
        const m = (as[i].getAttribute('href') || '').match(/\/photo\/(\d+)/);
        if (!m) continue;
        push(m[1], (as[i].textContent || '').replace(/\s+/g, ' ').trim());
      }

      return out;
    },

    // 真正的页面图长这样：/media/photos/{相册}/{5 位数字}.jpg
    // 阅读页里还混着广告位、占位图、图标之类的小图，它们被当成「页」去还原
    // 就会变成上下错位的花图，所以按这个形状先排掉。
    isPageImage(url) {
      const u = String(url).split('#')[0].split('?')[0];
      if (!/\/media\/photos\/\d+\//i.test(u)) return false;
      return /\/\d{3,6}\.[a-z]{2,5}$/i.test(u);
    },

    // 阅读页：img[data-original]，按 data-page 排；顺便记下这张要切几段
    imagesFromDoc(doc, baseUrl) {
      const imgs = doc.querySelectorAll('img[data-original], #divImage img, .scramble-page img');
      const list = [];

      for (let i = 0; i < imgs.length; i++) {
        const el = imgs[i];
        const src = el.getAttribute('data-original')
          || el.getAttribute('data-src')
          || el.getAttribute('src') || '';
        if (!src || /^data:/i.test(src) || /\/media\/albums\/blank/i.test(src)) continue;

        const u = abs(src, baseUrl);
        if (!u) continue;

        const page = el.getAttribute('data-page');
        list.push({
          url: u,
          page: page == null ? i : (parseInt(page, 10) || 0),
          ok: this.isPageImage(u)
        });
      }

      list.sort((a, b) => a.page - b.page);

      // 只留页面图；万一规则过严一张都不剩（站点改版了），就退回全部，
      // 宁可多几张也别让整章空白
      let picked = list.filter(x => x.ok);
      if (!picked.length) picked = list;

      // 打乱信息：scramble_id 在页面脚本里，编号从地址里拿
      const scrambleId = this.scrambleIdOf(doc);
      const aid = this.photoIdOf(baseUrl);

      const out = [];
      for (let i = 0; i < picked.length; i++) {
        const u = picked[i].url;
        if (out.indexOf(u) >= 0) continue;
        out.push(u);
        // 只有页面图才记分割数：混进来的小图本来就没打乱，还原反而会弄花
        if (aid && picked[i].ok) jmSplit.set(bare(u), jmSplitNum(aid, scrambleId, jmFileName(u)));
      }
      return out;
    },

    async imagesFromHtml(html, url) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { items: this.imagesFromDoc(doc, url), total: 0 };
    },

    scrambleIdOf(doc) {
      const scripts = doc.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const m = (scripts[i].textContent || '').match(/var\s+scramble_id\s*=\s*(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
      return JM_SCRAMBLE_DEFAULT;
    },

    photoIdOf(url) {
      const m = String(url).match(/\/photo(?:s)?\/(\d+)/i);
      return m ? m[1] : '';
    },

    // 引擎拿到字节后会先过这里：把打乱的图还原成正常图
    async decodeImage(blob, url) {
      const num = jmSplit.get(bare(url));
      if (!num) return blob;
      return jmUnscramble(blob, num);
    }
  };


  const SITES = [MANGACOPY, EHENTAI, NHENTAI, JMCOMIC];

  function detectSite(url) {
    for (let i = 0; i < SITES.length; i++) {
      if (SITES[i].host.test(url.hostname)) return SITES[i];
    }
    return null;
  }

  async function fetchText(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      // Accept 照抄浏览器的：站点按 Accept 分流，伪装成浏览器更容易拿到完整页面
      const res = await fetch(url, {
        credentials: 'include',
        signal: ctl.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  let frameEl = null;

  function getFrame() {
    if (frameEl && frameEl.isConnected) return frameEl;
    const f = document.createElement('iframe');
    // 不加 allow-popups：广告想弹窗会被浏览器直接拦掉。
    // allow-same-origin 保留同源身份，脚本才能读它的 document。
    f.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms');
    f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1100px;height:1400px;border:0;' +
      'opacity:0;pointer-events:none;z-index:-1';
    (document.documentElement || document.body).appendChild(f);
    frameEl = f;
    return f;
  }

  function dropFrame() {
    if (frameEl) { try { frameEl.remove(); } catch (e) { /* ignore */ } }
    frameEl = null;
  }

  // 只有一个 iframe，目录和章节预取可能同时要用它——排队，别互相把 src 顶掉
  let frameBusy = Promise.resolve();

  function withFrame(fn) {
    const job = frameBusy.then(() => fn());
    frameBusy = job.then(() => {}, () => {});
    return job;
  }

  // 把 url 塞进 iframe，轮询到 ready(doc, win) 为真（或超时）再交回 document
  function frameLoad(url, ready, timeout) {
    const f = getFrame();
    return new Promise(resolve => {
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        clearInterval(tick);
        clearTimeout(hard);
        resolve(v);
      };
      const tick = setInterval(() => {
        let d = null;
        try { d = f.contentDocument; } catch (e) { return; }
        if (!d || d.readyState === 'loading') return;
        let ok = false;
        try { ok = !!ready(d, f.contentWindow); } catch (e) { ok = false; }
        if (ok) finish(d);
      }, 250);
      const hard = setTimeout(() => finish(null), timeout || 25000);
      try { f.src = url; } catch (e) { finish(null); }
    });
  }

  // 在 iframe 里把页面往下慢慢推，逼站点把懒加载的图都吐出来
  async function frameSettleImages(win, doc) {
    const list = doc.querySelector('ul.comicContent-list');
    if (!list) return 0;
    const site = S.site || MANGACOPY;
    const total = site.pageCount ? site.pageCount(doc) : 0;

    let last = -1;
    let stall = 0;
    for (let i = 0; i < 90; i++) {
      const n = list.querySelectorAll('img').length;
      if (total && n >= total) break;
      if (n === last) stall++; else { stall = 0; last = n; }
      if (stall > 8) break;
      try {
        win.scrollTo(0, doc.body.scrollHeight);
        doc.documentElement.scrollTop = doc.body.scrollHeight;
      } catch (e) { /* ignore */ }
      await sleep(300);
    }
    return list.querySelectorAll('img').length;
  }

  const chCache = new Map();      // 章节 url -> {images, state, last}
  const chInflight = new Map();

  function cachedChapter(url) {
    const key = bare(url);
    return chCache.get(key) || null;
  }

  function chapterImages(chUrl) {
    const key = bare(chUrl);
    const hit = chCache.get(key);
    if (hit && hit.images && hit.images.length) return Promise.resolve(hit.images);
    if (chInflight.has(key)) return chInflight.get(key);

    const job = (async () => {
      let images = [];
      let total = 0;
      let how = '';
      try {
        // 有 JSON 接口的站（比如 nhentai）：一次请求拿全章地址，
        // 比「抓 HTML + 逐页解析」快一个数量级。失败就退回下面的老路。
        const fast = await fastImages(chUrl);
        if (fast) {
          images = fast.images;
          total = fast.total;
          how = fast.how;
        } else if (sameUrl(chUrl, location.href)) {
          const r = await liveImages();
          images = r.images;
          total = r.total || 0;
          how = r.how;
        } else {
          const r = await remoteImages(chUrl);
          images = r.images;
          total = r.total || 0;
          how = r.how;
        }
      } catch (e) {
        log('章节读取失败 ' + chUrl + ' · ' + (e && e.message));
      }
      const prev = chCache.get(key);
      chCache.set(key, {
        images: images,
        total: Math.max(total || 0, images.length),
        more: (total || 0) > images.length,   // 还有没取到的（画廊缩略图分页）
        state: images.length ? 'ok' : 'fail',
        last: prev ? prev.last : 0,
        how: how
      });
      if (images.length) {
        log('章节就绪 ' + images.length + ' 张 · 来源 ' + how +
          (total > images.length ? '（本章共 ' + total + '）' : ''));
      }
      return images;
    })().finally(() => chInflight.delete(key));

    chInflight.set(key, job);
    return job;
  }

  // 适配器可以自己整章取图（有接口的站用得上）。返回 null 表示「我取不了，
  // 走原来的三条路」。约定返回 {images, total, how} 或 {items, total}。
  async function fastImages(chUrl) {
    const site = S.site;
    if (!site || !site.fetchImages) return null;

    try {
      const r = await site.fetchImages(chUrl);
      if (!r) return null;
      const items = Array.isArray(r) ? r : (r.images || r.items || []);
      if (!items.length) return null;
      return {
        images: items,
        total: (r && r.total) || items.length,
        how: (r && r.how) || '接口'
      };
    } catch (e) {
      log('接口取图失败，退回页面解析：' + (e && e.message));
      return null;
    }
  }

  // 当前页：站点脚本已经把这一章解好了，优先把完整列表挖出来
  async function liveImages() {
    const site = S.site || MANGACOPY;
    const declared = site.pageTotal ? site.pageTotal(document) : 0;

    // 1) 内联密文（最完整，不用滚动）
    const viaKeys = await inlineImages(document, location.href);
    if (viaKeys.length) return { images: viaKeys, total: viaKeys.length, how: '解密' };

    // 2) 已经渲染进 DOM 的部分
    const total = declared || (site.pageCount ? site.pageCount(document) : 0);
    const dom = site.imagesFromDoc(document, location.href);
    if (dom.length && (!total || dom.length >= total)) return { images: dom, total: total || dom.length, how: 'DOM' };

    // 3) 边滚边等站点追加
    const list = document.querySelector('ul.comicContent-list');
    if (list) {
      let last = -1;
      let stall = 0;
      for (let i = 0; i < 60; i++) {
        const n = list.querySelectorAll('img').length;
        if (total && n >= total) break;
        if (n === last) stall++; else { stall = 0; last = n; }
        if (stall > 10) break;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(250);
      }
    }
    const again = site.imagesFromDoc(document, location.href);
    return { images: again, total: total || again.length, how: again.length > dom.length ? '滚动' : 'DOM' };
  }

  async function remoteImages(chUrl) {
    const site = S.site || MANGACOPY;

    // 1) 后台抓 HTML，适配器自己解（快，且不影响页面）
    try {
      const html = await fetchText(chUrl);
      const r = await site.imagesFromHtml(html, chUrl);
      const items = Array.isArray(r) ? r : ((r && r.items) || []);
      if (items.length) return { images: items, total: (r && r.total) || items.length, how: 'HTML' };
    } catch (e) {
      log('后台抓取失败：' + (e && e.message));
    }

    // 2) 让浏览器自己渲染——站点用什么办法都行，我只读结果
    //    等什么算「渲染好了」由适配器决定（frameReady），默认按拷贝漫画的列表判
    const ready = site.frameReady
      ? d => !!site.frameReady(d)
      : d => d.querySelectorAll('ul.comicContent-list img').length > 0;

    return withFrame(async () => {
      const doc = await frameLoad(chUrl, ready, 25000);
      if (!doc) { dropFrame(); return { images: [], how: 'iframe 超时' }; }

      await frameSettleImages(doc.defaultView, doc);
      const images = site.imagesFromDoc(doc, chUrl);
      dropFrame();          // 用完就扔，别让一整页站点脚本常驻内存
      return { images: images, how: 'iframe' };
    });
  }

  // 有的站列表里给的是「页面地址」，得再请求一次才知道图在哪
  // （E-Hentai 就是）。同一页只解析一次；失败不缓存，下次还会重试。
  const imgUrl = new Map();        // 页面地址 -> 图片地址
  const imgPending = new Map();    // 正在解析的

  // 拿到已知的图片地址；还没解析过就先返回原地址（进度条、缓存键用）
  function resolvedOf(raw) {
    if (!raw) return null;
    return imgUrl.get(bare(raw)) || raw;
  }

  function resolveItem(raw) {
    if (!raw) return Promise.resolve(null);

    const key = bare(raw);
    if (imgUrl.has(key)) return Promise.resolve(imgUrl.get(key));

    const site = S.site;
    if (!site || !site.resolveItem) { imgUrl.set(key, raw); return Promise.resolve(raw); }
    if (imgPending.has(key)) return imgPending.get(key);

    const job = (async () => {
      try {
        const u = await site.resolveItem(raw);
        if (u) { imgUrl.set(key, u); return u; }
      } catch (e) {
        log('取图片地址失败 ' + raw + ' · ' + (e && e.message));
      }
      return null;
    })().finally(() => imgPending.delete(key));

    imgPending.set(key, job);
    return job;
  }

  // 本次会话里已经判定打不开的图片地址：再取就绕过所有缓存，直接走网络。
  // 只影响出过问题的那几页，别的页照常吃缓存。
  const badImg = new Set();

  // 重试前调用。一层层把「这一页」的缓存删掉：
  //   1) 页面地址 → 图片地址 的映射（不清的话重试还是拿到同一个地址）
  //   2) 预加载脚本在 sessionStorage 里记的 ehp:meta（同上，而且可能是过期链接）
  //   3) 本地图片字节（最要命的：坏掉的那份留着，重试永远读到它）
  //   4) 预加载脚本图片库里借来的那份
  async function forgetPage(raw) {
    if (!raw) return;

    const key = bare(raw);
    const img = imgUrl.get(key) || raw;

    imgUrl.delete(key);
    imgPending.delete(key);

    // 这一轮彻底不走缓存，免得坏数据又被读回来
    badImg.add(bare(img));
    badImg.add(key);

    const jobs = [idbDel(img)];
    if (img !== raw) jobs.push(idbDel(raw));
    if (S.site && S.site.id === 'ehentai') {
      forgetEhMeta(raw);
      jobs.push(dropEhImage(img));
    }

    // 删不干净也别把重试卡住：最多等 1.5 秒，剩下的让它在后台跑完
    await withTimeout(Promise.all(jobs).catch(() => null), 1500, null);
    log('已清掉这一页的缓存：' + img);
  }

  function readListCache(detailUrl) {
    try {
      const raw = JSON.parse(localStorage.getItem(LIST_KEY + bare(detailUrl)) || 'null');
      if (!raw || !raw.chapters || !raw.chapters.length) return null;
      if (Date.now() - (raw.ts || 0) > LIST_TTL) return null;
      return raw.chapters;
    } catch (e) { return null; }
  }

  function writeListCache(detailUrl, chapters) {
    if (!chapters || !chapters.length) return;
    try {
      localStorage.setItem(LIST_KEY + bare(detailUrl), JSON.stringify({ ts: Date.now(), chapters: chapters }));
    } catch (e) { /* 配额满了就算了 */ }
  }

  // 目录拿不到时的兜底：只有当前这一话，靠「下一話」链接也能接着读
  function fallbackChapters(chUrl, title) {
    return [{ title: title || '', url: bare(chUrl) }];
  }

  function fetchChapters(detailUrl) {
    const site = S.site || MANGACOPY;

    // 当前就在目录页：它的目录已经渲染好了
    if (site.isDetail(location.pathname)) {
      const here = site.chaptersFromDoc(document, detailUrl);
      if (here.length) return Promise.resolve(here);
    }

    const cached = readListCache(detailUrl);
    if (cached) return Promise.resolve(cached);

    return withFrame(() => frameLoad(detailUrl, d => site.chaptersFromDoc(d, detailUrl).length > 0, 25000))
      .then(doc => {
        if (!doc) { dropFrame(); return []; }
        const list = site.chaptersFromDoc(doc, detailUrl);
        writeListCache(detailUrl, list);
        dropFrame();
        return list;
      })
      .catch(() => []);
  }

  let dbPromise = null;
  const known = new Map();
  let pruning = false;

  function db() {
    if (!dbPromise) {
      const opening = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB 不可用')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE)) {
            const st = d.createObjectStore(STORE, { keyPath: 'url' });
            st.createIndex('ts', 'ts');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('indexedDB 打开失败'));
      });
      // 打不开就趁早放弃：宁可没有缓存，也不能让整个界面卡在等缓存上
      dbPromise = withTimeout(opening, 4000, null).then(d => {
        if (!d) throw new Error('indexedDB 打不开');
        return d;
      });
    }
    return dbPromise;
  }

  function idbReq(mode, run) {
    return db().then(d => new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB 操作失败'));
    })).catch(() => null);
  }

  const idbGet = url => idbReq('readonly', s => s.get(bare(url))).then(r => (r && r.blob) || null);
  const idbCount = () => idbReq('readonly', s => s.count()).then(r => r || 0);

  // 存下来的那份是不是坏数据：空文件、或者类型明显不是图片。
  // 有些站出错时返回 200 + 一张 HTML 错误页，字节会被当图片存进库里，
  // 之后每次打开这一页都从缓存读这份垃圾——重试多少次都是同一张坏图。
  function isBadBlob(b) {
    if (!b || !b.size) return true;
    const t = String(b.type || '').toLowerCase();
    // 认不出类型的交给 <img> 自己判断，别误杀
    if (!t || t === 'application/octet-stream' || t === 'binary/octet-stream') return false;
    return !/^image\//.test(t);
  }

  // 只删一张（重试时用）。known / 计数一起改，进度条跟着变回未缓存。
  async function idbDel(url) {
    const key = bare(url);
    const d = await db().catch(() => null);
    if (!d) return false;

    const ok = await new Promise(resolve => {
      try {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
    if (!ok) return false;

    const size = known.get(key);
    if (size != null) {
      known.delete(key);
      S.cache.n = Math.max(0, S.cache.n - 1);
      S.cache.b = Math.max(0, S.cache.b - size);
      view.barSig = '';
      render();
    }
    return true;
  }

  async function idbPut(url, blob) {
    const key = bare(url);
    try {
      await db().then(d => new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ url: key, blob: blob, ts: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('写入失败'));
        tx.onabort = () => reject(tx.error || new Error('写入中止'));
      }));
      return true;
    } catch (e) {
      const quota = e && (e.name === 'QuotaExceededError' || e.code === 22);
      if (!quota) return false;
      try {
        await trimTo(Math.max(5, Math.floor(cfg.maxBlob / 2)));
        await db().then(d => new Promise((resolve, reject) => {
          const tx = d.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ url: key, blob: blob, ts: Date.now() });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        }));
        return true;
      } catch (e2) { return false; }
    }
  }

  async function trimTo(limit) {
    const count = await idbCount();
    if (count <= limit) return 0;

    let drop = count - limit;
    let removed = 0;
    const d = await db().catch(() => null);
    if (!d) return 0;

    await new Promise(resolve => {
      const tx = d.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.indexNames.contains('ts') ? store.index('ts').openCursor() : store.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c || drop <= 0) return;
        const v = c.value;
        c.delete();
        known.delete(v.url);
        S.cache.n = Math.max(0, S.cache.n - 1);
        S.cache.b = Math.max(0, S.cache.b - ((v.blob && v.blob.size) || 0));
        drop--; removed++;
        c.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    if (removed) log('缓存超出上限，淘汰 ' + removed + ' 张最旧的图片');
    return removed;
  }

  async function maybePrune() {
    if (pruning || S.cache.n <= cfg.maxBlob) return;
    pruning = true;
    try { await trimTo(cfg.maxBlob); } finally { pruning = false; render(); }
  }

  async function idbStat() {
    const d = await db().catch(() => null);
    if (!d) return;

    let n = 0;
    let bytes = 0;
    known.clear();

    await new Promise(resolve => {
      const tx = d.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const v = c.value;
        const size = (v.blob && v.blob.size) || 0;
        known.set(v.url, size);
        bytes += size;
        n++;
        c.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });

    S.cache.n = n;
    S.cache.b = bytes;
    render();
  }

  function markCache(url, size) {
    const key = bare(url);
    const old = known.get(key);
    if (old == null) S.cache.n++;
    else S.cache.b = Math.max(0, S.cache.b - old);
    known.set(key, size);
    S.cache.b += size;
    maybePrune();
    render();
  }

  async function clearCache() {
    try {
      const d = await db();
      await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      known.clear();
      S.cache.n = 0;
      S.cache.b = 0;
      log('图片缓存已清空');
      render();
    } catch (e) { log('清空缓存失败：' + (e && e.message)); }
  }

  const dl = { q: [], queued: new Set(), active: new Set(), running: 0 };

  // 走页面自己的网络栈（和 <img> 同一条路，代理、UA、Cookie 都跟浏览器一致）
  function fetchBlob(url) {
    return fetch(url, { credentials: 'include' }).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    });
  }

  function gmBlob(url) {
    if (typeof GM_xmlhttpRequest !== 'function') return fetchBlob(url);

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        timeout: 30000,
        headers: { Referer: location.origin + '/' },
        onload: r => {
          if (r.status >= 200 && r.status < 300 && r.response) resolve(r.response);
          else reject(new Error('HTTP ' + r.status));
        },
        onerror: () => reject(Object.assign(new Error('网络错误'), { net: true })),
        ontimeout: () => reject(Object.assign(new Error('超时'), { net: true }))
      });
    }).catch(e => {
      // 扩展的网络栈和页面自己的不是一回事（代理设置、UA、Cookie 都可能不同），
      // 遇到网络层错误就换 fetch 再试一次；HTTP 错误（404/403）就不用试了
      if (!e || !e.net) throw e;
      return fetchBlob(url).catch(() => { throw e; });
    });
  }

  function queueBlob(url) {
    if (!cfg.blobCache || !url) return;
    // 队列里按归一化 key 去重，但真正下载用的必须是原始地址
    // （有的图床把签名放在 query 上，归一化会把它抹掉）
    const key = bare(url);
    if (dl.queued.has(key) || dl.active.has(key)) return;
    dl.queued.add(key);
    dl.q.push({ key: key, url: url });
    pumpDl();
  }

  function pumpDl() {
    while (dl.running < CONCURRENCY && dl.q.length) {
      const item = dl.q.shift();
      dl.queued.delete(item.key);
      dl.running++;
      runDl(item);
    }
  }

  // 下下来的东西是不是一张真能解开的图。有的服务器会在中途断掉，返回一份
  // 头部完好、后面截断的文件——类型看着是 image/jpeg，其实打不开。
  // 这种一旦进了缓存，这一页就再也打不开了，所以入库前先试着解一次。
  async function canDecode(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        if (bmp && bmp.close) bmp.close();
        return true;
      } catch (e) { return false; }
    }
    return new Promise(resolve => {
      const u = URL.createObjectURL(blob);
      const im = new Image();
      const done = ok => { dropUrl(u); resolve(ok); };
      im.onload = () => done(im.naturalWidth > 0);
      im.onerror = () => done(false);
      im.src = u;
    });
  }

  // 有的站图片是打乱过的（18comic），拿到字节后要先还原才能看
  async function decodeBlob(url, blob) {
    const site = S.site;
    if (!site || !site.decodeImage || !blob) return blob;
    try {
      const out = await site.decodeImage(blob, url);
      return out || blob;
    } catch (e) {
      log('图片还原失败 ' + url + ' · ' + (e && e.message));
      return blob;
    }
  }

  // 需要还原的图：没有缓存就当场下一份、还原、存库
  const decodedPending = new Map();

  function fetchDecoded(url) {
    const key = bare(url);
    if (decodedPending.has(key)) return decodedPending.get(key);

    const job = (async () => {
      const raw = await gmBlob(url);
      if (isBadBlob(raw)) return null;
      const fixed = await decodeBlob(url, raw);
      if (cfg.blobCache) {
        Promise.resolve(idbPut(url, fixed))
          .then(ok => { if (ok) markCache(url, fixed.size || 0); })
          .catch(() => {});
      }
      return fixed;
    })().finally(() => decodedPending.delete(key));

    decodedPending.set(key, job);
    return job;
  }

  async function runDl(item) {
    dl.active.add(item.key);
    try {
      if (!cfg.blobCache) return;
      const existed = await idbGet(item.url);
      if (existed && !isBadBlob(existed)) { markCache(item.url, existed.size || 0); return; }
      if (existed) idbDel(item.url).catch(() => {});   // 库里那份是坏的，删掉重下

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await sleep(700 + Math.random() * 600);
        try {
          const blob = await gmBlob(item.url);
          // 200 但返回的是错误页/空文件：别把它当图片存进去，不然这一页就废了
          if (isBadBlob(blob)) throw new Error('返回的不是图片');
          const fixed = await decodeBlob(item.url, blob);   // 打乱的图先还原
          if (!(await canDecode(fixed))) throw new Error('图片解不开（可能下到一半断了）');
          if (await idbPut(item.url, fixed)) { markCache(item.url, fixed.size || 0); return; }
        } catch (e) {
          if (attempt === 1) log('图片缓存失败 ' + item.url + ' · ' + (e && e.message));
        }
      }
    } finally {
      dl.active.delete(item.key);
      dl.running--;
      pumpDl();
    }
  }

  const S = {
    open: false,
    site: null,
    book: null,          // {title, detailUrl, chapters:[{title,url}], ready}
    at: null,            // 当前章节 url
    ci: -1,              // 当前章节序号（目录没到时为 -1）
    idx: 0,              // 本章第几页（0 起）
    images: [],          // 本章图片地址（也可能是待解析的页面地址）
    total: 0,            // 本章声明总页数（0 = 不声明，以 images.length 为准）
    more: false,         // 本章还可能有没取到的部分（画廊缩略图分页）
    listLoading: false,
    step: 1,             // 这一屏实际显示了几页（1 或 2）
    stepNav: 1,          // 翻页步长：按格子算，配对的那张没加载出来也算 2
    zoom: 1,
    view: 0,
    gen: 0,
    dims: { l: null, r: null },
    note: '',
    noteKind: '',
    cache: { n: 0, b: 0 },

    // 条漫模式：整章图片竖着排成一列连续滚动，滚到底自动接下一话
    strip: { on: false, items: [], raf: 0, appending: false, blobs: [] }
  };

  function chapter() {
    if (!S.book || S.ci < 0) return null;
    return S.book.chapters[S.ci] || null;
  }

  function chapterTitle() {
    const ch = chapter();
    if (ch && ch.title) return ch.title;
    return '';
  }

  function setNote(text, kind) {
    S.note = text;
    S.noteKind = kind || '';
    render();
  }

  // 出图失败：状态点和提示条一起给，省得每处各写一遍
  function paintFail(key, vars) {
    const text = msg(key, vars);
    view.setLoading(false);
    view.tip(text);
    setNote(text, 'bad');
  }

  // 整章一张图都没读到（单页和条漫共用）
  function chapterFailed(ch) {
    const name = (ch && ch.title) || '';
    const text = msg('tip.chapterFail', { name: name });
    view.setLoading(false);
    view.tip(text);
    setNote(text, 'bad');
  }

  function posKey() {
    return POS_KEY + (S.book && S.book.detailUrl ? bare(S.book.detailUrl) : location.pathname);
  }

  function savePos() {
    if (!S.book || !S.at || !S.images.length) return;
    try {
      localStorage.setItem(posKey(), JSON.stringify({ url: bare(S.at), idx: S.idx, ts: Date.now() }));
    } catch (e) { /* ignore */ }
  }

  function loadPos() {
    try {
      const v = JSON.parse(localStorage.getItem(posKey()) || 'null');
      if (v && v.url && Number.isFinite(v.idx)) return v;
    } catch (e) { /* ignore */ }
    return null;
  }

  const CSS = `
#cmv{
  all:initial;position:fixed;inset:0;z-index:2147483001;display:block;overflow:hidden;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
  font-size:12px;line-height:1.45;color:var(--c-ink);background:var(--c-bg);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;color-scheme:dark;
  --c-ink:#f4f4f5;--c-muted:#a1a1aa;--c-surface:#18181b;--c-surface2:#27272a;
  --c-line:#2e2e33;--c-line2:#3f3f46;--c-ok:#2dd4bf;--c-warn:#fbbf24;--c-bad:#f87171;
  --c-bg:#0b0b0e;--c-bar:rgba(24,24,27,.84);
}
#cmv[data-theme="light"]{
  color-scheme:light;
  --c-ink:#18181b;--c-muted:#71717a;--c-surface:#ffffff;--c-surface2:#f4f4f5;
  --c-line:#e4e4e7;--c-line2:#d4d4d8;--c-ok:#0f766e;--c-warn:#b45309;--c-bad:#b91c1c;
  --c-bg:#f4f4f5;--c-bar:rgba(255,255,255,.88);
}
#cmv *,#cmv *::before,#cmv *::after{box-sizing:border-box}
#cmv .c-stage{position:absolute;inset:0;display:flex;overflow:auto;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:var(--c-line2) transparent;user-select:none;-webkit-user-select:none}
#cmv .c-spread{margin:auto;flex:none;display:flex;align-items:center;justify-content:center;gap:0;
  width:max-content;height:max-content;min-width:100%;min-height:100%}
#cmv .c-img{display:block;flex:none;object-fit:fill;user-select:none;-webkit-user-drag:none}
#cmv .c-img[hidden]{display:none}
/* 整章图片竖着排成一列，图片之间不留缝；滚到底由脚本接着挂下一话。 */
/* 条漫画布：竖排一列，图之间不留缝。用 align-items:flex-start + margin:auto
   居中，这样放大到比屏幕还宽时不会把左边裁掉（居中溢出滚不回去）。
   min-width:0 很关键：不然 flex 项的 min-content 会被最宽那张图撑开，
   整列反而被居中到屏幕外。 */
#cmv .c-strip{margin:0 auto;flex:none;width:100%;min-width:0;display:flex;flex-direction:column;
  align-items:flex-start;gap:0;--zx:100%}
#cmv .c-strip[hidden],#cmv .c-spread[hidden]{display:none}
#cmv .c-simg{display:block;width:100%;height:auto;margin:0 auto;user-select:none;-webkit-user-drag:none}
/* 还没轮到的图先占个位：不然一堆 0 高度会全挤在视口里，
   IntersectionObserver 会把整章一次性全下载 */
#cmv .c-simg:not([src]){min-height:70vh}
/* 条漫也听「适应 / 宽度 / 原始」：
   适应 = 只缩不放（原图比屏幕窄就居中，两头留空）；宽度 = 铺满；原始 = 原始像素 */
#cmv .c-strip[data-fit="width"] .c-simg{width:var(--zx);max-width:none}
#cmv .c-strip[data-fit="contain"] .c-simg{width:auto;max-width:var(--zx)}
#cmv .c-strip[data-fit="original"] .c-simg{width:auto;max-width:none}
#cmv .c-simg[data-gap]{min-height:60vh;background:var(--c-surface2)}
#cmv.c-zoomed .c-stage{cursor:grab}
#cmv.c-dragging .c-stage{cursor:grabbing}
#cmv .c-zoom{position:absolute;left:50%;bottom:58px;z-index:4;transform:translateX(-50%);
  padding:3px 10px;border:1px solid var(--c-line);border-radius:999px;background:var(--c-surface);color:var(--c-ink);
  font-size:11px;font-variant-numeric:tabular-nums;letter-spacing:.02em;
  opacity:0;transition:opacity .18s ease;pointer-events:none}
#cmv .c-zoom.is-on{opacity:1}
#cmv .c-veil{position:absolute;inset:0;z-index:2;display:grid;place-items:center;pointer-events:none;opacity:0;transition:opacity .15s ease}
#cmv .c-veil.is-on{opacity:1}
#cmv .c-veil span{width:26px;height:26px;border-radius:50%;border:2px solid var(--c-line2);border-top-color:var(--c-ok);animation:c-spin .8s linear infinite}
#cmv .c-tip{position:absolute;left:50%;bottom:56px;z-index:4;display:flex;align-items:center;gap:10px;max-width:min(460px,calc(100vw - 32px));
  padding:9px 12px;border:1px solid var(--c-line);border-radius:10px;background:var(--c-surface);color:var(--c-ink);
  box-shadow:0 1px 2px rgba(0,0,0,.05),0 12px 28px -14px rgba(0,0,0,.3);transform:translateX(-50%)}
#cmv .c-tip[hidden]{display:none}
#cmv .c-tip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--c-muted)}
#cmv .c-tip button{flex:none;padding:3px 9px;border:1px solid var(--c-line);border-radius:6px;background:transparent;color:var(--c-ink);font:inherit;font-size:11px;cursor:pointer}
#cmv .c-tip button:hover{background:var(--c-surface2)}
#cmv .c-bar,#cmv .c-foot{position:absolute;left:0;right:0;z-index:3;display:flex;align-items:center;gap:8px;
  background:var(--c-bar);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  transition:opacity .16s ease,transform .16s ease}
#cmv .c-bar{top:0;padding:7px 10px;border-bottom:1px solid var(--c-line)}
#cmv .c-foot{bottom:0;padding:5px 10px;gap:12px;border-top:1px solid var(--c-line)}
#cmv.c-hide .c-bar{opacity:0;transform:translateY(-8px);pointer-events:none}
#cmv.c-hide .c-foot{opacity:0;transform:translateY(8px);pointer-events:none}
#cmv .c-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--c-line2);transition:background-color .2s}
#cmv .c-dot.is-ok{background:var(--c-ok)}
#cmv .c-dot.is-warn{background:var(--c-warn)}
#cmv .c-dot.is-bad{background:var(--c-bad)}
#cmv .c-title{flex:0 1 auto;min-width:0;font-weight:600;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cmv .c-chip{flex:none;max-width:220px;padding:1px 7px;border:1px solid var(--c-line);border-radius:999px;
  font-size:10.5px;color:var(--c-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cmv .c-count{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--c-muted);letter-spacing:.01em}
#cmv .c-gap{flex:1;min-width:8px}
#cmv .c-btn{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--c-muted);cursor:pointer}
#cmv .c-btn:hover{background:var(--c-surface2);color:var(--c-ink)}
#cmv .c-btn.is-on{color:var(--c-ok);background:var(--c-surface2)}
#cmv .c-seg{flex:none;display:inline-flex;align-items:center;height:24px;border:1px solid var(--c-line);border-radius:7px;overflow:hidden;background:var(--c-surface)}
#cmv .c-seg button{height:100%;padding:0 8px;border:0;background:transparent;color:var(--c-muted);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
#cmv .c-seg button:hover{background:var(--c-surface2);color:var(--c-ink)}
#cmv .c-seg button.is-on{background:var(--c-surface2);color:var(--c-ink);font-weight:600}
#cmv .c-seg-sm button{padding:0 7px;font-size:10.5px}
#cmv .c-panel{position:absolute;top:44px;right:10px;z-index:6;width:286px;padding:10px;display:grid;gap:8px;
  max-height:calc(100vh - 56px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;
  border:1px solid var(--c-line);border-radius:12px;background:var(--c-surface);color:var(--c-ink);
  box-shadow:0 2px 4px rgba(0,0,0,.06),0 20px 44px -22px rgba(0,0,0,.65)}
#cmv .c-panel[hidden]{display:none}
#cmv .c-row{display:flex;align-items:center;gap:8px;min-height:24px}
#cmv .c-row.c-sub{padding-left:9px;border-left:2px solid var(--c-line);margin-left:1px}
#cmv .c-row.c-sub .c-lab{font-size:10.5px}
#cmv .c-row.c-sub.is-muted{opacity:.5}
#cmv .c-lab{flex:1;min-width:0;font-size:11px;color:var(--c-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cmv .c-cacheinfo{flex:none;font-size:11px;color:var(--c-ink);font-variant-numeric:tabular-nums}
/* 语言用一排小按钮，不用原生 select：深色面板里原生下拉一按就按系统配色画，
   盖住当前值、看不清。按钮和旁边几行是同一套样式，怎么点都读得出来。 */
#cmv .c-lang-seg{flex:none}
#cmv .c-lang-seg button{flex:none;padding:0 6px;font-size:10.5px;white-space:nowrap}
#cmv .c-mini{flex:none;height:22px;padding:0 8px;border:1px solid var(--c-line);border-radius:6px;background:transparent;color:var(--c-muted);font:inherit;font-size:11px;cursor:pointer}
#cmv .c-mini:hover{background:var(--c-surface2);color:var(--c-ink)}
#cmv .c-chaps{width:min(340px,92vw);grid-template-rows:auto 1fr;gap:6px;overflow:hidden}
#cmv .c-find{width:100%;height:30px;padding:0 9px;border:1px solid var(--c-line);border-radius:7px;
  background:var(--c-surface2);color:var(--c-ink);font:inherit;font-size:12px;outline:none}
#cmv .c-find:focus{box-shadow:inset 0 0 0 1px var(--c-ok)}
#cmv .c-chap-list{display:flex;flex-direction:column;gap:2px;max-height:min(62vh,540px);overflow-y:auto;
  overscroll-behavior:contain;scrollbar-width:thin;padding:2px}
/* flex:none 是关键：不加的话，几百话时每一行都会被压扁到读不出字 */
#cmv .c-chap{flex:none;display:block;width:100%;padding:6px 9px;border:0;border-radius:6px;background:transparent;
  color:var(--c-muted);font:inherit;font-size:12px;line-height:1.45;text-align:left;cursor:pointer;
  white-space:normal;overflow-wrap:anywhere}
#cmv .c-chap:hover{background:var(--c-surface2);color:var(--c-ink)}
#cmv .c-chap.is-cur{background:var(--c-surface2);color:var(--c-ok);font-weight:600}
#cmv .c-chap-msg{padding:8px;color:var(--c-muted);font-size:11.5px;text-align:center;line-height:1.6}
#cmv .c-progress{flex:1;display:flex;align-items:center;gap:2px;height:10px;min-width:0}
#cmv .c-progress span{flex:1;min-width:2px;height:5px;border-radius:2px;background:var(--c-line2);cursor:pointer;transition:background-color .15s,opacity .15s}
#cmv .c-progress span:hover{opacity:.65}
#cmv .c-progress span.is-ready{background:var(--c-ok);opacity:.55}
#cmv .c-progress span.is-cur{height:9px;border-radius:3px;background:var(--c-ink);opacity:1}
@keyframes c-spin{to{transform:rotate(360deg)}}
#cmv .c-stepper{flex:none;display:inline-flex;align-items:center;width:100px;height:24px;border:1px solid var(--c-line);border-radius:7px;overflow:hidden;background:var(--c-surface)}
#cmv .c-stepper button{flex:none;width:22px;height:100%;padding:0;border:0;background:transparent;color:var(--c-muted);font:inherit;font-size:13px;line-height:1;cursor:pointer}
#cmv .c-stepper button:hover:not(:disabled){background:var(--c-surface2);color:var(--c-ink)}
#cmv .c-stepper button:disabled{opacity:.35;cursor:default}
#cmv .c-num{flex:1;width:100%;min-width:0;height:100%;padding:0 2px;border:0;border-left:1px solid var(--c-line);border-right:1px solid var(--c-line);
  border-radius:0;background:transparent;color:var(--c-ink);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;text-align:center;
  outline:none;appearance:none;-webkit-appearance:none}
#cmv .c-num:hover{background:var(--c-surface2)}
#cmv .c-num:focus{background:var(--c-surface2);box-shadow:inset 0 0 0 1px var(--c-ok)}
#cmv .c-switch{flex:none;display:inline-flex;align-items:center;cursor:pointer}
#cmv .c-switch input{position:absolute;width:0;height:0;opacity:0;pointer-events:none}
#cmv .c-toggle{position:relative;flex:none;width:26px;height:15px;border-radius:999px;background:var(--c-line2);transition:background-color .15s}
#cmv .c-toggle::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
#cmv .c-switch input:checked + .c-toggle{background:var(--c-ok)}
#cmv .c-switch input:checked + .c-toggle::after{transform:translateX(11px)}
#cmv button:focus-visible{outline:2px solid var(--c-ok);outline-offset:1px}
#cmv-launch{
  all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;
  padding:7px 11px;border:1px solid var(--l-line);border-radius:10px;background:var(--l-surface);color:var(--l-ink);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
  font-size:12px;line-height:1.45;font-weight:600;letter-spacing:.01em;cursor:pointer;
  box-shadow:0 1px 2px rgba(0,0,0,.05),0 12px 28px -14px rgba(0,0,0,.3);
  --l-ink:#18181b;--l-muted:#71717a;--l-surface:#ffffff;--l-line:#e4e4e7;--l-ok:#0f766e;
}
#cmv-launch[data-theme="dark"]{--l-ink:#f4f4f5;--l-muted:#a1a1aa;--l-surface:#18181b;--l-line:#2e2e33;--l-ok:#2dd4bf;box-shadow:0 1px 2px rgba(0,0,0,.4),0 12px 28px -14px rgba(0,0,0,.8)}
#cmv-launch:hover{border-color:var(--l-ok)}
#cmv-launch .c-l-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--l-ok)}
#cmv-launch .c-key{font-size:10px;font-weight:500;color:var(--l-muted);opacity:1}
@media (prefers-reduced-motion:reduce){#cmv *{animation:none!important;transition:none!important}}
`;

  const TEMPLATE = `
<div class="c-stage">
  <div class="c-spread">
    <img class="c-img" alt="" decoding="async" hidden>
    <img class="c-img" alt="" decoding="async" hidden>
  </div>
  <div class="c-strip" hidden></div>
</div>
<div class="c-veil"><span></span></div>
<div class="c-tip" hidden>
  <span class="c-tip-text"></span>
  <button type="button" class="c-tip-btn" data-i18n="tip.retry">重试</button>
</div>
<div class="c-zoom"><span class="c-zoom-txt"></span></div>
<div class="c-bar">
  <span class="c-dot"></span>
  <span class="c-title" data-i18n="app.title">看图</span>
  <span class="c-chip" hidden></span>
  <span class="c-gap"></span>
  <span class="c-seg" data-seg="fit">
    <button type="button" data-fit="contain" data-i18n="fit.contain">适应</button>
    <button type="button" data-fit="width" data-i18n="fit.width">宽度</button>
    <button type="button" data-fit="original" data-i18n="fit.original">原始</button>
  </span>
  <button class="c-btn" type="button" data-act="chaps" data-i18n-title="bar.chaps">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.2h10M3 8h10M3 11.8h6.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
  </button>
  <button class="c-btn" type="button" data-act="strip" data-i18n-title="bar.strip">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4.7" y="1.9" width="6.6" height="8.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 11.4v2.6M6.5 12.6L8 14.2l1.5-1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <button class="c-btn" type="button" data-act="spread" data-i18n-title="bar.spread">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2.2" y="3.6" width="4.8" height="8.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="3.6" width="4.8" height="8.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
  </button>
  <button class="c-btn" type="button" data-act="single" data-i18n-title="bar.single">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4.4" y="2.6" width="7.2" height="10.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 6.2v3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
  </button>
  <button class="c-btn" type="button" data-act="theme" data-i18n-title="bar.theme">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.6a5.4 5.4 0 010 10.8z" fill="currentColor"/></svg>
  </button>
  <button class="c-btn" type="button" data-act="settings" data-i18n-title="bar.settings">
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M6.68 0.77L8.00 0.65L9.32 0.77L10.01 3.15L10.98 3.68L12.18 1.95L13.20 2.80L14.05 3.82L12.85 5.99L13.16 7.06L15.23 6.68L15.35 8.00L15.23 9.32L12.85 10.01L12.32 10.98L14.05 12.18L13.20 13.20L12.18 14.05L10.01 12.85L8.94 13.16L9.32 15.23L8.00 15.35L6.68 15.23L5.99 12.85L5.02 12.32L3.82 14.05L2.80 13.20L1.95 12.18L3.15 10.01L2.84 8.94L0.77 9.32L0.65 8.00L0.77 6.68L3.15 5.99L3.68 5.02L1.95 3.82L2.80 2.80L3.82 1.95L5.99 3.15L7.06 2.84Z M10.45 8.00L10.26 7.06L9.73 6.27L8.94 5.74L8.00 5.55L7.06 5.74L6.27 6.27L5.74 7.06L5.55 8.00L5.74 8.94L6.27 9.73L7.06 10.26L8.00 10.45L8.94 10.26L9.73 9.73L10.26 8.94Z"/></svg>
  </button>
  <button class="c-btn" type="button" data-act="close" data-i18n-title="bar.close">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
  </button>
</div>
<div class="c-panel" hidden>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.lang">界面语言</span>
    <span class="c-seg c-seg-sm c-lang-seg" role="group" aria-label="Language">
      <button type="button" data-lang="zh">中文</button>
      <button type="button" data-lang="en">EN</button>
      <button type="button" data-lang="ja">日本語</button>
      <button type="button" data-lang="ko">한국어</button>
    </span>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.strip">条漫模式（整章连续滚动）</span>
    <label class="c-switch">
      <input type="checkbox" class="c-webtoon">
      <span class="c-toggle"></span>
    </label>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.spread">双页模式</span>
    <label class="c-switch">
      <input type="checkbox" class="c-dual">
      <span class="c-toggle"></span>
    </label>
  </div>
  <div class="c-row c-sub">
    <span class="c-lab" data-i18n="set.rtl">日漫模式（第二页在左）</span>
    <label class="c-switch">
      <input type="checkbox" class="c-rtl">
      <span class="c-toggle"></span>
    </label>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.ahead">预读取页数</span>
    <span class="c-stepper">
      <button type="button" data-step="-1" aria-label="减少预取页数">−</button>
      <input class="c-num c-ahead" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="3" value="4" aria-label="预读取页数，1 到 8">
      <button type="button" data-step="1" aria-label="增加预取页数">+</button>
    </span>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.maxblob">缓存页数上限</span>
    <span class="c-stepper">
      <button type="button" data-mb="-10" aria-label="减少缓存上限">−</button>
      <input class="c-num c-mb" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="4" value="120" aria-label="缓存页数上限，2 到 500">
      <button type="button" data-mb="10" aria-label="增加缓存上限">+</button>
    </span>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.blob">图片缓存</span>
    <label class="c-switch">
      <input type="checkbox" class="c-blob">
      <span class="c-toggle"></span>
    </label>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.cached">已缓存</span>
    <span class="c-cacheinfo">0 张 · 0 KB</span>
    <button type="button" class="c-mini c-clear" data-i18n="set.clear">清空缓存</button>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.tap">点击翻页（下一页）</span>
    <span class="c-seg c-seg-sm">
      <button type="button" data-tap="left" data-i18n="set.tapLeft" data-i18n-title="set.tapLeftTip">左边</button>
      <button type="button" data-tap="right" data-i18n="set.tapRight" data-i18n-title="set.tapRightTip">右边</button>
    </span>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.single">单页步进（校准）</span>
    <label class="c-switch">
      <input type="checkbox" class="c-single">
      <span class="c-toggle"></span>
    </label>
  </div>
  <div class="c-row">
    <span class="c-lab" data-i18n="set.wheel">鼠标滚轮</span>
    <span class="c-seg c-seg-sm">
      <button type="button" data-wheel="page" data-i18n="set.wheelPage" data-i18n-title="set.wheelPageTip">翻页</button>
      <button type="button" data-wheel="zoom" data-i18n="set.wheelZoom" data-i18n-title="set.wheelZoomTip">放大</button>
    </span>
  </div>
</div>
<div class="c-panel c-chaps" hidden>
  <input class="c-find" type="text" data-i18n-ph="chaps.search" placeholder="搜索章节…" autocomplete="off" spellcheck="false">
  <div class="c-chap-list"></div>
</div>
<div class="c-foot">
  <span class="c-count">– / –</span>
  <div class="c-progress"></div>
</div>`;

  function ensureStyle() {
    if (document.getElementById('cmv-style')) return;
    const style = document.createElement('style');
    style.id = 'cmv-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  const view = {
    el: null,
    refs: null,
    raf: 0,
    barSig: '',
    barsOn: false,
    lastWheel: 0,
    chapSig: '',

    build() {
      if (this.el) return;
      ensureStyle();

      const root = document.createElement('div');
      root.id = 'cmv';
      root.className = 'c-hide';
      root.dataset.theme = cfg.theme;
      root.dataset.fit = cfg.fit;
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', msg('app.title'));
      root.innerHTML = TEMPLATE;

      const q = s => root.querySelector(s);
      const imgs = root.querySelectorAll('.c-img');
      this.refs = {
        stage: q('.c-stage'),
        spread: q('.c-spread'),
        strip: q('.c-strip'),
        imgL: imgs[0],
        imgR: imgs[1],
        bar: q('.c-bar'),
        foot: q('.c-foot'),
        panel: q('.c-panel:not(.c-chaps)'),
        chaps: q('.c-chaps'),
        chapList: q('.c-chap-list'),
        find: q('.c-find'),
        veil: q('.c-veil'),
        tip: q('.c-tip'),
        tipText: q('.c-tip-text'),
        tipBtn: q('.c-tip-btn'),
        zoomBadge: q('.c-zoom'),
        zoomTxt: q('.c-zoom-txt'),
        dot: q('.c-dot'),
        title: q('.c-title'),
        chip: q('.c-chip'),
        count: q('.c-count'),
        progress: q('.c-progress'),
        cacheInfo: q('.c-cacheinfo'),
        ahead: q('.c-ahead'),
        minus: q('[data-step="-1"]'),
        plus: q('[data-step="1"]'),
        mbVal: q('.c-mb'),
        mbMinus: q('[data-mb="-10"]'),
        mbPlus: q('[data-mb="10"]'),
        blob: q('.c-blob'),
        langBtns: root.querySelectorAll('button[data-lang]'),
        webtoon: q('.c-webtoon'),
        stripRow: q('.c-webtoon').closest('.c-row'),
        single: q('.c-single'),
        dual: q('.c-dual'),
        dualRow: q('.c-dual').closest('.c-row'),
        rtl: q('.c-rtl'),
        rtlRow: q('.c-sub'),
        spreadBtn: q('button[data-act="spread"]'),
        stripBtn: q('button[data-act="strip"]'),
        singleBtn: q('button[data-act="single"]'),
        wheelBtns: root.querySelectorAll('button[data-wheel]'),
        fitBtns: root.querySelectorAll('button[data-fit]'),
        tapBtns: root.querySelectorAll('button[data-tap]')
      };

      this.el = root;
      this.wire();
      document.documentElement.appendChild(root);
      applyLang();              // 模板里的字先换成当前语言

      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this.layout());
        this._ro.observe(this.refs.stage);
      }

      this.paint();
    },

    /* 按原图比例算两张图各自的像素尺寸，紧贴排布、不留缝。
       contain = 整组缩放到刚好装满可视区；width = 铺满宽度；
       original = 原始像素，装不下就滚动。
       长图（条漫）例外：contain 时只缩不放，见下面的 natural 分支。 */
    layout() {
      const r = this.refs;
      if (!r) return;
      if (S.strip.on) return;      // 条漫模式由 stripApplyFit 控制宽度，这里不管

      const W = r.stage.clientWidth;
      const H = r.stage.clientHeight;
      if (!W || !H) return;

      const dL = r.imgL.hidden ? null : S.dims.l;
      const dR = r.imgR.hidden ? null : S.dims.r;

      if (!dL) { r.imgL.style.width = ''; r.imgL.style.height = ''; }
      if (!dR) { r.imgR.style.width = ''; r.imgR.style.height = ''; }
      if (!dL && !dR) return;

      let w = 0;
      let h = 0;
      if (dL) { w += dL.w; h = Math.max(h, dL.h); }
      if (dR) { w += dR.w; h = Math.max(h, dR.h); }

      // 长图（条漫）按「适应」时只缩不放：铺满宽度会把整条放大到失真，
  // 一屏也看不到多少内容。比屏幕窄就居中留着两头，宽了才缩。
      const strip = h / Math.max(1, w) > 2.2;
      const fit = cfg.fit === 'contain' && strip ? 'natural' : cfg.fit;

      let s;
      if (fit === 'original') s = 1;
      else if (fit === 'width') s = W / w;
      else if (fit === 'natural') s = Math.min(1, W / w);
      else s = Math.min(W / w, H / h);
      s *= S.zoom;

      const put = (el, d) => {
        if (!d) return;
        el.style.width = Math.max(1, Math.round(d.w * s)) + 'px';
        el.style.height = Math.max(1, Math.round(d.h * s)) + 'px';
      };
      put(r.imgL, dL);
      put(r.imgR, dR);

      const overflow = w * s > W + 1 || h * s > H + 1;
      this.el.classList.toggle('c-zoomed', overflow);
    },

    destroy() {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      clearTimeout(this._badgeTimer);
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      window.removeEventListener('keydown', this._onKey, true);
      window.removeEventListener('resize', this._onResize);
      if (this.el) {
        this.el.removeEventListener('wheel', this._onWheel);
        this.el.removeEventListener('click', this._onClick);
        this.el.removeEventListener('change', this._onChange);
        this.el.removeEventListener('input', this._onInput);
        this.el.removeEventListener('keydown', this._onFieldKey);
        this.el.removeEventListener('pointerdown', this._onDown);
        this.el.removeEventListener('pointermove', this._onMove);
        this.el.removeEventListener('pointerup', this._onUp);
        this.el.removeEventListener('pointercancel', this._onUp);
        this.el.remove();
      }
      this.el = null;
      this.refs = null;
      this.barSig = '';
      this.chapSig = '';
      this.barsOn = false;
      this.drag = null;
      this.suppressClick = false;
    },

    wire() {
      this._onKey = e => onKey(e);
      this._onResize = () => {
        this.layout();
        if (S.strip.on) stripApplyFit();   // 条漫按窗口宽度重算一次性宽
      };
      this._onWheel = e => onWheel(e);
      this._onClick = e => this.onClick(e);
      this._onChange = e => this.onChange(e);
      this._onInput = e => this.onInput(e);
      this._onFieldKey = e => this.onFieldKey(e);
      this._onDown = e => this.onPointerDown(e);
      this._onMove = e => this.onPointerMove(e);
      this._onUp = e => this.onPointerUp(e);

      window.addEventListener('keydown', this._onKey, true);
      window.addEventListener('resize', this._onResize);
      this.el.addEventListener('wheel', this._onWheel, { passive: false });
      this.el.addEventListener('click', this._onClick);
      this.el.addEventListener('change', this._onChange);
      this.el.addEventListener('input', this._onInput);
      this.el.addEventListener('keydown', this._onFieldKey);
      this.el.addEventListener('pointerdown', this._onDown);
      this.el.addEventListener('pointermove', this._onMove);
      this.el.addEventListener('pointerup', this._onUp);
      this.el.addEventListener('pointercancel', this._onUp);
      this.refs.stage.addEventListener('scroll', () => onStripScroll(), { passive: true });
      this.refs.tipBtn.addEventListener('click', () => retry());
    },

    onClick(e) {
      const t = e.target;
      if (!(t instanceof Element)) return;

      if (this.suppressClick) { this.suppressClick = false; return; }

      const act = t.closest('button[data-act]');
      if (act) { onAction(act.getAttribute('data-act')); return; }

      const langBtn = t.closest('button[data-lang]');
      if (langBtn) { setLang(langBtn.getAttribute('data-lang')); return; }

      const chap = t.closest('.c-chap');
      if (chap) { jumpChapter(parseInt(chap.dataset.ci, 10)); return; }

      const fit = t.closest('button[data-fit]');
      if (fit) { setFit(fit.getAttribute('data-fit')); return; }

      const step = t.closest('button[data-step]');
      if (step) { stepAhead(parseInt(step.getAttribute('data-step'), 10)); return; }

      const mb = t.closest('button[data-mb]');
      if (mb) { stepMaxBlob(parseInt(mb.getAttribute('data-mb'), 10)); return; }

      const tap = t.closest('button[data-tap]');
      if (tap) { setTapSide(tap.getAttribute('data-tap')); return; }

      const wheel = t.closest('button[data-wheel]');
      if (wheel) { setWheelMode(wheel.getAttribute('data-wheel')); return; }

      if (t.closest('.c-clear')) { clearCache(); return; }
      if (t.closest('.c-tip-btn')) { retry(); return; }

      const seg = t.closest('.c-progress span');
      if (seg) { goIndex(parseInt(seg.dataset.page, 10)); return; }

      if (t.closest('.c-bar, .c-foot, .c-panel')) return;

      if (this.refs.panel && !this.refs.panel.hidden) { this.showPanel(null); return; }
      if (this.refs.chaps && !this.refs.chaps.hidden) { this.showPanel(null); return; }

      const r = this.el.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      if (x < 0.32) { if (cfg.tapSwap) next(); else prev(); }
      else if (x > 0.68) { if (cfg.tapSwap) prev(); else next(); }
      else this.toggleBars();
    },

    onChange(e) {
      const t = e.target;
      if (!t || !t.classList) return;

      if (t.classList.contains('c-blob')) {
        cfg.blobCache = !!t.checked;
        saveCfg();
        if (cfg.blobCache) prefetch();
        render();
        return;
      }

      if (t.classList.contains('c-single')) {
        cfg.singleStep = !!t.checked;
        saveCfg();
        render();
        return;
      }

      if (t.classList.contains('c-webtoon')) {
        if (S.strip.on !== !!t.checked) toggleStrip();
        return;
      }

      if (t.classList.contains('c-dual')) {
        if (cfg.spread !== !!t.checked) toggleSpread();
        return;
      }

      if (t.classList.contains('c-rtl')) {
        setRtl(!!t.checked);
        return;
      }

      if (t.classList.contains('c-num')) commitNum(t);
    },

    onInput(e) {
      const t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('c-find')) { renderChaps(t.value); return; }
      if (!t.classList.contains('c-num')) return;
      const clean = String(t.value || '').replace(/[^\d]/g, '').slice(0, 4);
      if (clean !== t.value) t.value = clean;
    },

    onFieldKey(e) {
      const t = e.target;
      if (!t || !t.classList) return;
      if (!t.classList.contains('c-num') && !t.classList.contains('c-find')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (t.classList.contains('c-num')) t.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (t.classList.contains('c-find')) { t.value = ''; renderChaps(''); }
        else {
          t.value = String(t.classList.contains('c-ahead') ? cfg.ahead : cfg.maxBlob);
          t.blur();
        }
      }
      e.stopPropagation();
    },

    showBars(on) {
      if (!this.el) return;
      this.barsOn = !!on;
      this.el.classList.toggle('c-hide', !on);
      if (!on) this.showPanel(null);
    },

    toggleBars() { this.showBars(!this.barsOn); },

    // which: 'set' | 'chaps' | null
    showPanel(which) {
      const r = this.refs;
      if (!r) return;
      const p = r.panel;
      const c = r.chaps;

      const openSet = which === 'set' && p.hidden;
      const openChaps = which === 'chaps' && c.hidden;

      p.hidden = !openSet;
      c.hidden = !openChaps;

      if (openChaps) {
        this.showBars(true);
        renderChaps(r.find.value);
        const cur = r.chapList.querySelector('.is-cur');
        if (cur && typeof cur.scrollIntoView === 'function') {
          try { cur.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        }
      }
    },

    setLoading(on) {
      if (!this.refs) return;
      this.refs.veil.classList.toggle('is-on', !!on);
    },

    tip(text) {
      if (!this.refs) return;
      if (!text) { this.refs.tip.hidden = true; return; }
      this.refs.tipText.textContent = text;
      this.refs.tip.hidden = false;
    },

    badge(text) {
      if (!this.refs) return;
      const el = this.refs.zoomBadge;
      if (!text) { el.classList.remove('is-on'); return; }
      this.refs.zoomTxt.textContent = text;
      el.classList.add('is-on');
      clearTimeout(this._badgeTimer);
      this._badgeTimer = setTimeout(() => { if (this.refs) this.refs.zoomBadge.classList.remove('is-on'); }, 800);
    },

    onPointerDown(e) {
      if (!S.open || e.button !== 0) return;
      const t = e.target;
      if (t instanceof Element && t.closest('.c-bar, .c-foot, .c-panel, .c-tip')) return;

      this.suppressClick = false;

      const stage = this.refs && this.refs.stage;
      if (!stage) return;
      if (stage.scrollWidth <= stage.clientWidth + 1 && stage.scrollHeight <= stage.clientHeight + 1) return;

      this.drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        sl: stage.scrollLeft,
        st: stage.scrollTop,
        moved: false
      };
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    },

    onPointerMove(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;

      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 5) return;

      d.moved = true;
      const stage = this.refs.stage;
      stage.scrollLeft = d.sl - dx;
      stage.scrollTop = d.st - dy;
      if (this.el) this.el.classList.add('c-dragging');
    },

    onPointerUp(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;

      this.drag = null;
      if (this.el) this.el.classList.remove('c-dragging');
      if (d.moved) {
        this.suppressClick = true;
        clearTimeout(this._clickTimer);
        this._clickTimer = setTimeout(() => { this.suppressClick = false; }, 350);
      }
      try { this.refs.stage.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
    },

    render() {
      if (!this.el || this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.paint();
      });
    },

    paint() {
      if (!this.el) return;
      const r = this.refs;

      const book = S.book;
      r.title.textContent = (book && book.title) || msg('app.title');

      const ch = chapterTitle();
      const many = !!(book && book.chapters.length > 1);
      // 只有一话的站（比如 E-Hentai 的画廊）没必要再标一次章节名
      r.chip.hidden = !ch || !many;
      if (ch && many) {
        const n = book.chapters.length;
        r.chip.textContent = S.ci >= 0 ? ch + ' · ' + (S.ci + 1) + '/' + n : ch;
        r.chip.title = ch;
      }

      // 本章总页数：站点声明了就用它（E-Hentai 的「Length: N pages」），
      // 否则以已取到的为准
      const total = S.total || S.images.length;
      r.count.textContent = S.images.length
        ? (S.idx + 1) + (S.step > 1 && S.idx + 2 <= S.images.length ? '–' + (S.idx + 2) : '') + ' / ' + total
        : '– / –';

      const dot = r.dot;
      let dotCls = 'c-dot';
      if (S.noteKind === 'bad') dotCls += ' is-bad';
      else if (total) dotCls += ' is-ok';
      else if (S.note) dotCls += ' is-warn';
      dot.className = dotCls;
      dot.title = S.note || '';

      if (document.activeElement !== r.ahead) r.ahead.value = String(cfg.ahead);
      if (document.activeElement !== r.mbVal) r.mbVal.value = String(cfg.maxBlob);
      r.minus.disabled = cfg.ahead <= 1;
      r.plus.disabled = cfg.ahead >= MAX_AHEAD;
      r.mbMinus.disabled = cfg.maxBlob <= 2;
      r.mbPlus.disabled = cfg.maxBlob >= MAX_KEEP;
      r.cacheInfo.textContent = msg('set.cachedValue', { n: S.cache.n, size: fmtSize(S.cache.b) });
      markOn(r.langBtns, 'data-lang', cfg.lang);
      r.blob.checked = !!cfg.blobCache;
      r.webtoon.checked = !!S.strip.on;
      r.stripBtn.classList.toggle('is-on', !!S.strip.on);
      r.single.checked = !!cfg.singleStep;
      r.dual.checked = !!cfg.spread;
      r.rtl.checked = cfg.rtl !== false;
      if (r.rtlRow) r.rtlRow.classList.toggle('is-muted', !cfg.spread);
      // 条漫和双页互斥：开着的那个，另一个在设置里灰掉
      if (r.dualRow) r.dualRow.classList.toggle('is-muted', !!S.strip.on);
      if (r.stripRow) r.stripRow.classList.toggle('is-muted', !!cfg.spread);

      markOn(r.fitBtns, 'data-fit', cfg.fit);
      markOn(r.tapBtns, 'data-tap', cfg.tapSwap ? 'left' : 'right');
      markOn(r.wheelBtns, 'data-wheel', cfg.wheel);

      this.el.dataset.fit = cfg.fit;
      r.spreadBtn.classList.toggle('is-on', !!cfg.spread);
      r.singleBtn.classList.toggle('is-on', !!cfg.singleStep);

      if (!r.chaps.hidden) renderChaps(r.find.value);

      // 标签在窄面板里被省略号截断时，悬停能看全文
      const labs = this.el.querySelectorAll('.c-lab');
      for (let i = 0; i < labs.length; i++) {
        labs[i].title = labs[i].scrollWidth > labs[i].clientWidth + 1 ? labs[i].textContent : '';
      }

      this.paintBar();
    },

    paintBar() {
      const r = this.refs;
      const total = S.images.length;
      if (!total) { if (this.barSig) { this.barSig = ''; r.progress.replaceChildren(); } return; }

      if (total > 240) {
        // 超长章节不逐页画格子，画一条整体进度就够
        const pct = Math.round((S.idx / Math.max(1, total - 1)) * 100);
        const sig = 'wide:' + pct;
        if (sig === this.barSig) return;
        this.barSig = sig;
        const one = h('span');
        one.className = 'is-cur';
        one.style.flex = 'none';
        one.style.width = Math.max(2, pct) + '%';
        one.dataset.page = String(S.idx);
        r.progress.replaceChildren(one);
        return;
      }

      const lo = Math.max(0, S.idx - cfg.back - 2);
      const hi = Math.min(total - 1, S.idx + cfg.ahead);
      let sig = lo + ':' + hi + ':' + S.idx;
      for (let p = lo; p <= hi; p++) sig += '|' + p + (known.has(bare(resolvedOf(S.images[p]))) ? '1' : '0');
      if (sig === this.barSig) return;
      this.barSig = sig;

      const frag = document.createDocumentFragment();
      for (let p = lo; p <= hi; p++) {
        const seg = h('span');
        if (known.has(bare(resolvedOf(S.images[p])))) seg.className = 'is-ready';
        if (p === S.idx || (S.step > 1 && p === S.idx + 1)) seg.className += ' is-cur';
        seg.dataset.page = String(p);
        seg.title = '第 ' + (p + 1) + ' 页';
        frag.appendChild(seg);
      }
      r.progress.replaceChildren(frag);
    }
  };

  function render() { view.render(); }

  // 一组分段按钮里，属性等于 value 的那个标记为选中
  function markOn(btns, attr, value) {
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-on', btns[i].getAttribute(attr) === value);
    }
  }

  // 目录列表（可以带过滤词）
  function renderChaps(filter) {
    const r = view.refs;
    if (!r) return;

    const list = (S.book && S.book.chapters) || [];
    const key = String(filter || '').trim().toLowerCase();
    const sig = list.length + '|' + S.ci + '|' + key + '|' + S.listLoading;
    if (sig === view.chapSig) return;
    view.chapSig = sig;

    // 几百话的时候，搜索框上顺手标个总数，心里有数
    if (r.find) r.find.placeholder = msg(list.length ? 'chaps.searchN' : 'chaps.search', { n: list.length });

    const frag = document.createDocumentFragment();

    if (!list.length) {
      const line = h('div', 'c-chap-msg', msg(S.listLoading ? 'chaps.loading' : 'chaps.empty'));
      frag.appendChild(line);
      r.chapList.replaceChildren(frag);
      return;
    }

    let shown = 0;
    for (let i = 0; i < list.length; i++) {
      const name = list[i].title || msg('chaps.item', { n: i + 1 });
      if (key && name.toLowerCase().indexOf(key) < 0) continue;
      const b = h('button', 'c-chap', name);
      b.type = 'button';
      b.dataset.ci = String(i);
      if (i === S.ci) b.className += ' is-cur';
      b.title = name;
      frag.appendChild(b);
      shown++;
      if (shown > 800) break;
    }
    if (!shown) frag.appendChild(h('div', 'c-chap-msg', msg('chaps.noMatch')));
    r.chapList.replaceChildren(frag);
  }

  function dropUrl(u) {
    if (!u || u.indexOf('blob:') !== 0) return;
    setTimeout(() => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }, 8000);
  }

  async function srcOf(url) {
    if (!url) return { src: null, cached: false };

    // 这一页刚被判过死刑（点过重试）：缓存和别的脚本的库一律跳过，直接重下。
    // 不这样的话，刚删掉的坏数据会被同一份立刻填回来，重试等于没点。
    const fresh = badImg.has(bare(url));
    const site = S.site;

    if (cfg.blobCache && !fresh) {
      const blob = await withTimeout(idbGet(url), 1500, null);
      if (blob && isBadBlob(blob)) {
        log('缓存里是坏数据，丢掉重下：' + url);
        idbDel(url).catch(() => {});
      } else if (blob) {
        try { return { src: URL.createObjectURL(blob), cached: true }; } catch (e) { /* 落到网络地址 */ }
      }

      // 别的脚本（E-Hentai 预加载）已经下好这张？借过来，省一次下载
      if (site && site.borrowImage) {
        const other = await withTimeout(site.borrowImage(url), 1500, null);
        if (other && !isBadBlob(other)) {
          Promise.resolve(idbPut(url, other)).catch(() => {});
          try { return { src: URL.createObjectURL(other), cached: true }; } catch (e) { /* 落到网络地址 */ }
        }
      }
    }

    // 打乱的图（18comic）：必须还原才能显示。缓存里存的就是还原后的版本，
    // 没命中就当场下一份、还原、给个 blob 地址——不然画面上是乱序的图。
    if (site && site.decodeImage && !fresh) {
      const got = await withTimeout(fetchDecoded(url), 25000, null);
      if (got) {
        try { return { src: URL.createObjectURL(got), cached: true }; } catch (e) { /* 落到网络地址 */ }
      }
    }

    if (cfg.blobCache) queueBlob(url);
    return { src: url, cached: false };
  }

  // 要不要重新设一次 src。同一个地址如果上次没加载出来，元素停在 error 状态，
  // 光把同样的字符串再赋一遍浏览器不会重新请求——「重试」就成了空点。
  function needsReload(el, src) {
    if (el.getAttribute('src') !== src) return true;
    return el.complete && !el.naturalWidth;
  }

  function applySrc(el, src) {
    if (!src) {
      el.hidden = true;
      el.removeAttribute('src');
      return;
    }
    if (needsReload(el, src)) {
      dropUrl(el.getAttribute('src'));
      el.removeAttribute('src');     // 先清掉，确保下面这次是真的重新发起请求
      el.src = src;
    }
    el.hidden = false;
  }

  function applySrcQuiet(el, src) {
    if (!src) { el.hidden = true; el.removeAttribute('src'); return; }
    if (needsReload(el, src)) {
      dropUrl(el.getAttribute('src'));
      el.removeAttribute('src');
      el.src = src;
    }
    el.hidden = true;
  }

  function whenLoaded(el, ms) {
    const size = () => (el.naturalWidth ? { w: el.naturalWidth, h: el.naturalHeight } : null);

    // 已经好了就直接返回；「complete 但没宽度」不能当成失败——
    // 刚设完 src 的那一瞬间也可能处于这个状态，等一拍再判断。
    if (el.complete && el.naturalWidth) return Promise.resolve(size());

    const wait = () => new Promise(resolve => {
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeEventListener('load', onLoad);
        el.removeEventListener('error', onError);
        resolve(v);
      };
      const onLoad = () => finish(size());
      const onError = () => finish(null);
      const timer = setTimeout(() => finish(size()), ms || 25000);
      el.addEventListener('load', onLoad);
      el.addEventListener('error', onError);
    });

    if (el.complete) {
      return new Promise(resolve => {
        setTimeout(() => { if (el.complete) resolve(size()); else resolve(wait()); }, 80);
      });
    }
    return wait();
  }

  async function paintPage(token) {
    const r = view.refs;
    if (!r) return;

    view.setLoading(true);
    view.tip('');

    const raw = S.images[S.idx];
    if (!raw) { paintFail('tip.noImage'); return; }

    // 列表里可能是「页面地址」，先换成真正的图片地址（拷贝漫画是直接地址，不消耗请求）
    const url = await resolveItem(raw);
    if (token !== S.view) return;
    if (!url) { paintFail('tip.pageResolve', { n: S.idx + 1 }); return; }

    const slotMain = cfg.rtl ? r.imgR : r.imgL;
    const slotPair = cfg.rtl ? r.imgL : r.imgR;

    let a = await srcOf(url);
    if (token !== S.view) { dropUrl(a.src); return; }

    applySrcQuiet(slotMain, a.src);
    let mA = a.src ? await whenLoaded(slotMain) : null;
    if (token !== S.view) return;

    // 打不开时先自己换一条路重试一次，别直接把「重试」丢给用户：
    //   ① 这张来自缓存 → 缓存里那份坏了（下了一半、或者根本不是图），删掉改走网络
    //   ② 这张来自网络 → 地址可能过期（带时效签名的站），把映射丢掉重新换算
    // 不做这两步的话，坏数据会一直卡在那儿，点多少次重试都是同一个结果。
    if (!mA && a.cached) {
      log('缓存里的图打不开，丢掉改走网络：' + url);
      await forgetPage(raw);
      if (token !== S.view) return;
      a = await srcOf(url);
      if (token !== S.view) { dropUrl(a.src); return; }
      applySrcQuiet(slotMain, a.src);
      mA = a.src ? await whenLoaded(slotMain) : null;
      if (token !== S.view) return;
    }

    if (!mA && !a.cached && S.site && S.site.resolveItem && imgUrl.has(bare(raw))) {
      log('地址可能已过期，重新换算一次：' + raw);
      await forgetPage(raw);
      if (token !== S.view) return;
      const fresh = await resolveItem(raw);
      if (token !== S.view) return;
      if (fresh) {
        a = await srcOf(fresh);
        if (token !== S.view) { dropUrl(a.src); return; }
        applySrcQuiet(slotMain, a.src);
        mA = a.src ? await whenLoaded(slotMain) : null;
        if (token !== S.view) return;
      }
    }

    // 通用兜底：同一个地址隔一下再试一次。CDN 抽风、代理抖动造成的连接中断
    // （ERR_CONNECTION_CLOSED / 超时）重试一次常常就好了。
    // 这一步不分站点，对谁都生效。
    if (!mA && a.src) {
      await sleep(700);
      if (token !== S.view) return;
      applySrcQuiet(slotMain, a.src);       // needsReload 会强制重新发起请求
      mA = await whenLoaded(slotMain, 8000);
      if (token !== S.view) return;
      if (mA) log('重试一次就通了：' + url);
    }

    // 还不行就换候选地址。有的站一张图有好几个主机（nhentai 是 i1~i4），
    // 某个节点连不上时（典型症状是 ERR_CONNECTION_CLOSED）换一个就通了。
    if (!mA && S.site && S.site.fallbacks) {
      const alts = S.site.fallbacks(url) || [];
      if (alts.length) log('换个图片主机再试：' + alts.length + ' 个候选');
      for (let k = 0; k < alts.length; k++) {
        if (token !== S.view) return;
        const b = await srcOf(alts[k]);
        if (token !== S.view) { dropUrl(b.src); return; }
        applySrcQuiet(slotMain, b.src);
        mA = b.src ? await whenLoaded(slotMain, 8000) : null;
        if (token !== S.view) return;
        if (mA) {
          log('换主机成功：' + alts[k]);
          imgUrl.set(bare(raw), alts[k]);   // 记住这个，下次直接用
          break;
        }
      }
    }

    if (!mA) {
      log('这一页打不开：' + url);
      applySrc(r.imgR, null);
      applySrc(r.imgL, null);
      S.dims = { l: null, r: null };
      view.layout();
      paintFail('tip.pageFail', { n: S.idx + 1 });
      return;
    }
    slotMain.hidden = false;
    badImg.delete(bare(url));      // 这次出来了，以后照常吃缓存

    // 配对的一张：只在同一章里配，跨章不拼；横图和条漫都独占一屏
    let second = false;
    let mB = null;
    // 这一屏「本来该占两个格子」吗。配对的那张没加载出来时 second 是 false，
    // 但格子还占着——翻页得按两个走，不然会退回一页看到重复的页
    let slot = false;

    if (cfg.spread && mA.w <= mA.h && mA.h / Math.max(1, mA.w) < 2.2 && S.idx + 1 < S.images.length) {
      slot = true;
      const paired = await resolveItem(S.images[S.idx + 1]);
      if (token !== S.view) return;
      const c = await srcOf(paired);
      if (token !== S.view) { dropUrl(c.src); return; }

      if (c.src) {
        applySrcQuiet(slotPair, c.src);
        const m = await whenLoaded(slotPair);
        if (token !== S.view) return;
        if (m && m.w <= m.h) { slotPair.hidden = false; second = true; mB = m; }
        else {
          applySrc(slotPair, null);
          // m 为空 = 这张没加载出来，格子先留着；
          // m 有值但是横图 = 它本来就该独占一屏，格子不占
          if (m) slot = false;
        }
      } else {
        applySrc(slotPair, null);      // 连地址都没取到，同样留着格子
      }
    } else {
      applySrc(slotPair, null);
    }

    S.dims = cfg.rtl ? { l: mB, r: mA } : { l: mA, r: mB };
    view.layout();

    // 换页回到画面顶部：上一页可能被滚到页尾（条漫），不带过来
    r.stage.scrollTop = 0;
    r.stage.scrollLeft = 0;

    view.setLoading(false);

    S.step = second ? 2 : 1;                       // 这一屏实际显示了几页（只给计数用）
    S.stepNav = slot ? 2 : 1;                      // 翻页步长：按格子算，配对失败也算两页

    const span = second
      ? msg('note.pagesRange', { a: S.idx + 1, b: S.idx + 2 })
      : msg('note.pageOne', { n: S.idx + 1 });
    setNote(msg(a.cached ? 'note.cached' : 'note.net', { pages: span }), a.cached ? 'ok' : '');

    render();
    prefetch();
    savePos();
  }

  let stripIo = null;

  const stripEl = () => (view.refs ? view.refs.strip : null);

  function stripMake(url, ci, idx) {
    const img = document.createElement('img');
    img.className = 'c-simg';
    img.alt = '';
    img.decoding = 'async';
    img.dataset.url = url;
    img.dataset.ci = String(ci);
    img.dataset.idx = String(idx);
    return img;
  }

  // 图片快到视口才去取地址（能命中缓存就用缓存），一次很长的章节也不会全下
  function stripObserve(els) {
    const stage = view.refs && view.refs.stage;
    if (!stage || !els.length) return;

    if (!stripIo && typeof IntersectionObserver === 'function') {
      stripIo = new IntersectionObserver(entries => {
        for (let i = 0; i < entries.length; i++) {
          const en = entries[i];
          if (!en.isIntersecting) continue;
          const img = en.target;
          stripIo.unobserve(img);
          const url = img.dataset.url;
          if (!url || img.getAttribute('src')) continue;
          resolveItem(url).then(u => (u ? srcOf(u) : null)).then(r => {
            if (!r || !r.src || !img.isConnected || img.getAttribute('src')) return;
            // 图一加载出来就按当前模式定宽（缩放/换模式时这些 px 会被重算）
            img.addEventListener('load', () => stripSizeImage(img), { once: true });
            img.src = r.src;
            if (r.cached) S.strip.blobs.push(r.src);
            if (img.complete) stripSizeImage(img);
          }).catch(() => {});
        }
      }, { root: stage, rootMargin: '1500px 0px' });
    }

    for (let i = 0; i < els.length; i++) {
      if (stripIo) stripIo.observe(els[i]);
      else els[i].src = els[i].dataset.url;   // 老浏览器没有观察器，那就直接挂上
    }
  }

  // 条漫模式下把「适应 / 宽度 / 原始」落实成实际宽度。
  //   适应  = 只缩不放：原图比屏幕窄就居中显示、两头留空，宽了就缩到屏幕宽
  //   宽度  = 铺满屏幕（会放大，一屏看到的内容更少）
  //   原始  = 原始像素，超出屏幕就横向滚
  // 缩放倍数作为上限叠在上面；条漫允许缩到 50%，方便一屏多看一点
  // 一张条漫图的实际宽度 = 「适应/宽度/原始」的基准 × 缩放。
  // 必须写成像素：光靠 max-width 的话，原图比屏幕窄时放大只会抬高上限，
  // 实际宽度不动——那就等于滚轮放大失灵了。
  function stripSizeImage(img) {
    if (!img) return;
    const stage = view.refs && view.refs.stage;
    const W = stage ? stage.clientWidth : 0;
    const nw = img.naturalWidth || 0;

    if (!W) return;

    let px = 0;
    if (cfg.fit === 'width') {
      px = Math.round(W * S.zoom);
    } else if (!nw) {
      return;                              // 还没加载出来，先让 CSS 兜着
    } else {
      const base = cfg.fit === 'original' ? nw : Math.min(nw, W);
      px = Math.round(base * S.zoom);
    }

    img.style.width = px + 'px';
    img.style.maxWidth = 'none';
    // 比屏幕宽的时候靠左摆，不然居中溢出会把左边裁掉、还滚不回去
    const edge = px > W ? '0' : 'auto';
    img.style.marginLeft = edge;
    img.style.marginRight = edge;
  }

  function stripApplyFit() {
    const el = stripEl();
    if (!el) return;
    el.dataset.fit = cfg.fit;
    el.style.setProperty('--zx', Math.max(10, Math.round(S.zoom * 100)) + '%');
    for (let i = 0; i < S.strip.items.length; i++) stripSizeImage(S.strip.items[i].el);
  }

  function stripClear() {
    const el = stripEl();
    if (el) {
      el.replaceChildren();
      el.hidden = true;
      el.style.removeProperty('--zx');
      delete el.dataset.fit;
    }
    S.strip.items = [];
    for (let i = 0; i < S.strip.blobs.length; i++) dropUrl(S.strip.blobs[i]);
    S.strip.blobs.length = 0;
    if (stripIo) { try { stripIo.disconnect(); } catch (e) { /* ignore */ } stripIo = null; }
  }

  function stripScrollTo(ci, idx) {
    const it = S.strip.items.find(x => x.ci === ci && x.idx === idx);
    const stage = view.refs && view.refs.stage;
    if (!it || !it.el || !stage) return;
    stage.scrollTop = Math.max(0, it.el.offsetTop);
  }

  // 打开（或切换到）某一话：整章铺成一列
  async function stripOpen(ci, idx) {
    if (!S.open) return;
    const ch = S.book && S.book.chapters[ci];
    if (!ch) return;

    const token = ++S.view;
    view.setLoading(true);
    setNote(msg('note.opening', { name: ch.title || '' }), '');

    const imgs = await chapterImages(ch.url);
    if (token !== S.view || !S.strip.on) return;

    if (!imgs.length) { chapterFailed(ch); return; }

    adoptChapter(ci, ch, imgs, idx);

    stripClear();
    const el = stripEl();
    if (!el) return;
    el.hidden = false;
    if (view.refs.spread) view.refs.spread.hidden = true;

    const frag = document.createDocumentFragment();
    const els = [];
    S.strip.items = imgs.map((url, i) => {
      const img = stripMake(url, ci, i);
      frag.appendChild(img);
      els.push(img);
      return { url: url, ci: ci, idx: i, el: img };
    });
    el.appendChild(frag);

    stripApplyFit();
    stripObserve(els);

    S.barSig = '';
    view.refs.stage.scrollTop = 0;
    await sleep(20);
    if (token !== S.view) return;
    stripScrollTo(ci, S.idx);

    view.setLoading(false);
    setNote(msg('note.stripPage', { n: S.idx + 1 }), '');
    render();
    savePos();

    // 这一话短到一屏都填不满时，先把下一话垫上，否则等滚到底再挂
    const st = view.refs.stage;
    if (st && st.scrollHeight <= st.clientHeight + 200) stripAppendNext();
  }

  // 同一话还没取完（E-Hentai 的缩略图分页）：续一批接到列尾
  async function stripAppendMore() {
    if (!S.strip.on || S.strip.appending || !S.more) return;

    const before = S.images.length;
    S.strip.appending = true;
    const ok = await extendChapter();      // 它会往 S.images 里 push
    S.strip.appending = false;

    if (!ok || !S.strip.on) return;
    const el = stripEl();
    if (!el) return;

    const frag = document.createDocumentFragment();
    const added = [];
    for (let i = before; i < S.images.length; i++) {
      const img = stripMake(S.images[i], S.ci, i);
      frag.appendChild(img);
      added.push(img);
      S.strip.items.push({ url: S.images[i], ci: S.ci, idx: i, el: img });
    }
    el.appendChild(frag);
    stripObserve(added);
    render();
  }

  // 往列尾挂下一话。滚到底部附近调用；已经挂过就不重复。
  async function stripAppendNext() {
    if (!S.strip.on || S.strip.appending || !S.book || S.ci < 0) return;

    const ci = S.ci + 1;
    const ch = S.book.chapters[ci];
    if (!ch) return;
    if (S.strip.items.some(it => it.ci === ci)) return;

    const at = S.ci;
    S.strip.appending = true;
    let imgs = [];
    try { imgs = await chapterImages(ch.url); } catch (e) { imgs = []; }
    S.strip.appending = false;

    // 等的时候可能已经切章或退出条漫了，别再往旧列表里塞
    if (!S.strip.on || !imgs.length || S.ci !== at) return;
    const el = stripEl();
    if (!el) return;

    const frag = document.createDocumentFragment();
    const added = [];
    for (let i = 0; i < imgs.length; i++) {
      const img = stripMake(imgs[i], ci, i);
      frag.appendChild(img);
      added.push(img);
      S.strip.items.push({ url: imgs[i], ci: ci, idx: i, el: img });
    }
    el.appendChild(frag);
    stripObserve(added);
    render();
  }

  // 滚动时按「视口上方三分之一处」判定当前在哪一页、哪一话
  function stripSync() {
    if (!S.strip.on || !S.open) return;
    const r = view.refs;
    if (!r) return;

    const stage = r.stage;
    const items = S.strip.items;
    if (!items.length) return;

    const mid = stage.scrollTop + Math.min(stage.clientHeight * 0.3, 240);
    let hit = items[0];
    for (let i = 0; i < items.length; i++) {
      const el = items[i].el;
      if (!el) continue;
      if (el.offsetTop <= mid) hit = items[i];
      else break;
    }

    const prevCi = S.ci;
    if (hit.ci !== S.ci) {
      const ch = S.book.chapters[hit.ci];
      const c = ch ? cachedChapter(ch.url) : null;
      S.ci = hit.ci;
      if (ch) S.at = ch.url;
      if (c && c.images && c.images.length) S.images = c.images;
      view.chapSig = '';
    }

    if (hit.idx !== S.idx || hit.ci !== prevCi) {
      S.idx = hit.idx;
      S.barSig = '';
      render();
      savePos();
    }

    if (stage.scrollTop + stage.clientHeight > stage.scrollHeight - 1600) {
      if (S.more) stripAppendMore();
      else stripAppendNext();
    }
  }

  function onStripScroll() {
    if (!S.strip.on || !S.open || S.strip.raf) return;
    S.strip.raf = requestAnimationFrame(() => {
      S.strip.raf = 0;
      stripSync();
    });
  }

  function toggleStrip() {
    const next = !S.strip.on;

    // 条漫是整章一列滚，双页是两张拼一屏，两个只能开一个
    if (next && cfg.spread) { cfg.spread = false; }

    cfg.strip = next;
    saveCfg();

    if (!S.open) { S.strip.on = next; render(); return; }

    S.strip.on = next;
    render();

    if (next) {
      stripOpen(S.ci >= 0 ? S.ci : 0, S.idx);
      setNote(msg('note.stripHint'), '');
    } else {
      stripClear();
      if (view.refs) {
        view.refs.spread.hidden = false;
        view.refs.stage.scrollTop = 0;
      }
      S.barSig = '';
      paintPage(++S.view);
    }
  }

  // 把某一章的图片装进阅读状态（单页和条漫共用，保证两边切换时位置一致）
  function adoptChapter(ci, ch, imgs, idx) {
    const meta = cachedChapter(ch.url) || {};
    S.ci = ci;
    S.at = ch.url;
    S.images = imgs;
    S.total = meta.total || imgs.length;
    S.more = !!meta.more;
    S.step = 1;
    S.stepNav = 1;
    S.idx = clamp(idx < 0 ? imgs.length + idx : idx, 0, imgs.length - 1);
    S.barSig = '';
  }

  async function openChapter(ci, idx) {
    if (!S.open) return;
    const list = S.book && S.book.chapters;
    const ch = list && list[ci];
    if (!ch) return;

    // 条漫模式走另一条渲染路径（整章铺一列）
    if (S.strip.on) { stripOpen(ci, idx); return; }

    const token = ++S.view;
    view.setLoading(true);
    setNote(msg('note.opening', { name: ch.title }), '');

    const imgs = await chapterImages(ch.url);
    if (token !== S.view) return;

    if (!imgs.length) { chapterFailed(ch); return; }

    adoptChapter(ci, ch, imgs, idx);
    await paintPage(token);
  }

  // 换章不刷页：同一个 iframe/fetch 拿到的结果都进缓存，回看是秒切
  function jumpChapter(ci) {
    if (!S.open || ci < 0) return;
    view.showPanel(null);
    if (ci === S.ci) return;
    // 离开当前章时记一下位置，回来能接着看
    const cur = chCache.get(bare(S.at));
    if (cur) cur.last = S.idx;
    openChapter(ci, 0);
  }

  function goIndex(i) {
    if (!S.open || !S.images.length) return;
    if (!Number.isFinite(i)) return;
    const t = clamp(i, 0, S.images.length - 1);
    if (t === S.idx) return;

    if (S.strip.on) {
      S.idx = t;
      stripScrollTo(S.ci, t);
      render();
      return;
    }

    S.idx = t;
    const token = ++S.view;
    paintPage(token);
  }

  // 就地重画当前页（页码不变）。开关双页 / 日漫之后要立刻按新布局重新配对，
  // 不能等下一次翻页才生效
  function repaint() {
    if (!S.open || !S.images.length) return;
    if (S.strip.on) { stripApplyFit(); return; }
    paintPage(++S.view);
  }

  // 翻一屏走几页。用 stepNav 而不是 step：双页模式下配对的第二张没加载出来时，
  // 那一屏只显示一页，但格子还占着，后退要退回「上一个双页」，不是「上一页」。
  function stepOf() {
    if (cfg.singleStep) return 1;
    return S.stepNav > 1 ? S.stepNav : 1;
  }

  // 格子占着但页码可能不够：别因为步长是 2 就把后面真实存在的页跳过去。
  // 正常情况（这一屏真的显示了两页）不裁剪，章末照样能翻到下一话。
  function navStep(dir) {
    let n = stepOf();
    const total = S.images.length;
    if (n > S.step) {
      if (dir > 0 && S.idx + n > total - 1) n = Math.max(1, total - 1 - S.idx);
      if (dir < 0 && S.idx - n < 0) n = S.idx;
    }
    return n;
  }

  // 本章还分着页（E-Hentai 的缩略图分页）：再要一批，接到 images 末尾
  async function extendChapter() {
    if (!S.more || !S.at) return false;

    const key = bare(S.at);
    const c = chCache.get(key);
    if (!c || c.extending) return false;

    const site = S.site;
    if (!site || !site.extendChapter) { c.more = false; S.more = false; return false; }

    const at = S.at;
    c.extending = true;
    let more = [];
    try { more = await site.extendChapter(at, S.images.length); } catch (e) { more = []; }
    c.extending = false;

    if (!S.open || !sameUrl(S.at, at)) return false;

    const seen = new Set(S.images.map(u => bare(u)));
    const added = [];
    for (let i = 0; i < more.length; i++) {
      const u = more[i];
      if (!u || seen.has(bare(u))) continue;
      seen.add(bare(u));
      S.images.push(u);
      added.push(u);
    }
    if (!added.length) { c.more = false; S.more = false; }
    if (S.total && S.images.length >= S.total) { c.more = false; S.more = false; }
    if (added.length) { S.barSig = ''; render(); }
    return added.length > 0;
  }

  function next() {
    if (!S.open) return;

    // 条漫模式：翻页 = 往下滚一屏（滚到底会自动接下一话）
    if (S.strip.on) {
      const stage = view.refs && view.refs.stage;
      if (stage) stage.scrollTop += Math.round(stage.clientHeight * 0.88);
      return;
    }

    const total = S.images.length;
    if (!total) return;

    const t = S.idx + navStep(1);
    if (t < total) { goIndex(t); return; }

    // 本章还没取完（E-Hentai 的缩略图分页）→ 先续一批再翻
    if (S.more) {
      extendChapter().then(ok => {
        if (ok && S.idx + navStep(1) < S.images.length) goIndex(S.idx + navStep(1));
        else if (!ok && S.ci >= 0 && S.ci + 1 < S.book.chapters.length) jumpChapter(S.ci + 1);
        else if (!ok) setNote(msg('note.lastPage'), '');
      });
      return;
    }

    if (S.ci >= 0 && S.ci + 1 < S.book.chapters.length) { jumpChapter(S.ci + 1); return; }
    setNote(msg('note.lastPage'), '');
  }

  function prev() {
    if (!S.open) return;

    if (S.strip.on) {
      const stage = view.refs && view.refs.stage;
      if (stage) stage.scrollTop -= Math.round(stage.clientHeight * 0.88);
      return;
    }

    const total = S.images.length;
    if (!total) return;

    const t = S.idx - navStep(-1);
    if (t >= 0) { goIndex(t); return; }
    if (S.ci > 0) {
      const cur = chCache.get(bare(S.at));
      if (cur) cur.last = S.idx;
      openChapter(S.ci - 1, -1);
      return;
    }
    setNote(msg('note.firstPage'), '');
  }

  function gotoChapterDelta(delta) {
    if (!S.open) return;
    const ci = S.ci + delta;
    if (ci < 0) { setNote(msg('note.firstChapter'), ''); return; }
    if (!S.book.chapters[ci]) { setNote(msg('note.lastChapter'), ''); return; }
    jumpChapter(ci);
  }

  // 预取：先把后面几张图下进缓存，再把下一章的首图备好
  function prefetch() {
    if (!S.open || !cfg.blobCache) return;
    if (!S.book || !S.images.length) return;

    const total = S.images.length;
    const end = Math.min(total, S.idx + cfg.ahead + (S.stepNav > 1 ? 1 : 0));
    for (let p = S.idx; p < end; p++) {
      const raw = S.images[p];
      if (!raw) continue;
      // 页面地址要先换算出图片地址，才能下载（直接地址会立刻返回，不占请求）
      resolveItem(raw).then(u => { if (u) queueBlob(u); }).catch(() => {});
    }

    // 快翻到本章末尾时，提前把下一章的图片列表解出来（切章就几乎无感）
    if (S.ci >= 0 && S.idx >= total - 4) {
      const nextCh = S.book.chapters[S.ci + 1];
      if (nextCh && !cachedChapter(nextCh.url) && !chInflight.has(bare(nextCh.url))) {
        chapterImages(nextCh.url).then(imgs => {
          if (!S.open || !imgs || !imgs.length) return;
          resolveItem(imgs[0]).then(u => { if (u) queueBlob(u); }).catch(() => {});
        }).catch(() => {});
      }
    }
  }

  // 重试：先把出错这一页的缓存删掉，再重新取。
  // 只重开章节是不够的——坏掉的那张图还躺在库里，读回来还是它。
  async function retry() {
    if (!S.open) return;
    view.tip('');

    await forgetPage(S.images[S.idx]);
    if (cfg.spread) await forgetPage(S.images[S.idx + 1]);

    // 只有章节列表本身没取到（或上次就失败了）才整章重来。
    // 只是某一页坏掉的话，重抓整章纯属浪费——站点限流时这一步还会必失败。
    const c = chCache.get(bare(S.at));
    if (!c || c.state !== 'ok') chCache.delete(bare(S.at));

    openChapter(Math.max(0, S.ci), S.idx);
  }

  function onAction(act) {
    if (act === 'close') { close(); return; }
    if (act === 'chaps') { view.showPanel('chaps'); view.showBars(true); return; }
    if (act === 'strip') { toggleStrip(); return; }
    if (act === 'spread') { toggleSpread(); return; }
    if (act === 'single') { toggleSingle(); return; }
    if (act === 'theme') { toggleTheme(); return; }
    if (act === 'settings') { view.showPanel('set'); view.showBars(true); return; }
  }

  function setFit(fit) {
    cfg.fit = fit;
    saveCfg();
    if (view.refs) {
      view.el.dataset.fit = fit;
      // 换适配方式就回到 1 倍：「宽度」必须正好铺满，别带着上次的缩放
      S.zoom = 1;
      if (S.strip.on) {
        stripApplyFit();
        view.badge('');
      } else {
        view.refs.stage.scrollTop = 0;
        view.refs.stage.scrollLeft = 0;
        view.layout();
      }
    }
    render();
  }

  const ZOOM_MAX = 8;

  // 单页模式最小就是 1（再小只是留白）；条漫允许缩到 50%，一屏多看一截
  function zoomMin() { return S.strip.on ? 0.5 : 1; }

  function zoomTo(z, cx, cy) {
    const r = view.refs;
    if (!S.open || !r) return;

    const prevZ = S.zoom;
    z = clamp(z, zoomMin(), ZOOM_MAX);
    if (Math.abs(z - prevZ) < 0.002) return;

    const stage = r.stage;
    const rect = stage.getBoundingClientRect();
    const ax = cx == null ? stage.clientWidth / 2 : cx - rect.left;
    const ay = cy == null ? stage.clientHeight / 2 : cy - rect.top;
    const px = stage.scrollLeft + ax;
    const py = stage.scrollTop + ay;
    const k = z / prevZ;

    S.zoom = z;

    if (S.strip.on) {
      // 条漫：缩放宽高都变，但别把阅读位置甩到顶部
      stripApplyFit();
      stage.scrollLeft = Math.max(0, px * k - ax);
      stage.scrollTop = Math.max(0, py * k - ay);
    } else {
      view.layout();
      if (z > 1) {
        stage.scrollLeft = Math.max(0, px * k - ax);
        stage.scrollTop = Math.max(0, py * k - ay);
      } else {
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
      }
    }

    view.badge(Math.round(z * 100) + '%');
    render();
  }

  function zoomStep(dir, cx, cy) {
    const min = zoomMin();
    let z = dir > 0 ? S.zoom * 1.2 : S.zoom / 1.2;
    if (z < min * 1.02) z = min;      // 到下限就贴住，别越缩越虚
    zoomTo(z, cx, cy);
  }

  function resetZoom() {
    if (!S.open || S.zoom === 1) return;
    S.zoom = 1;
    if (S.strip.on) stripApplyFit();
    else view.layout();
    if (view.refs) {
      view.refs.stage.scrollLeft = 0;
      if (!S.strip.on) view.refs.stage.scrollTop = 0;
    }
    view.badge('100%');
    render();
  }

  function setWheelMode(m) {
    cfg.wheel = m === 'zoom' ? 'zoom' : 'page';
    saveCfg();
    render();
  }

  function toggleSpread() {
    // 要开双页就先退出条漫（两个模式互斥）
    if (!cfg.spread && S.strip.on) toggleStrip();

    cfg.spread = !cfg.spread;
    saveCfg();
    render();
    if (S.open) repaint();      // 原地重画，不然要等翻页才拼上第二张
  }

  function toggleSingle() {
    cfg.singleStep = !cfg.singleStep;
    saveCfg();
    render();
    if (S.open) setNote(msg(cfg.singleStep ? 'note.singleOn' : 'note.singleOff'), '');
  }

  function setRtl(on) {
    if (cfg.rtl === on) return;
    cfg.rtl = on;
    saveCfg();
    render();
    if (S.open) repaint();
  }

  function setLang(lang) {
    if (LANG_LIST.indexOf(lang) < 0 || lang === cfg.lang) return;
    cfg.lang = lang;
    saveCfg();
    applyLang();
  }

  function setTapSide(side) {
    cfg.tapSwap = side === 'left';
    saveCfg();
    render();
  }

  function toggleTheme() {
    cfg.theme = cfg.theme === 'dark' ? 'light' : 'dark';
    saveCfg();
    if (view.el) view.el.dataset.theme = cfg.theme;
    syncLauncherTheme();
  }

  function stepAhead(delta) {
    const v = clamp(cfg.ahead + delta, 1, MAX_AHEAD);
    if (v === cfg.ahead) return;
    cfg.ahead = v;
    saveCfg();
    render();
    prefetch();
  }

  function stepMaxBlob(delta) {
    const v = clamp(cfg.maxBlob + delta, 2, MAX_KEEP);
    if (v === cfg.maxBlob) return;
    cfg.maxBlob = v;
    saveCfg();
    render();
    maybePrune();
  }

  function commitNum(el) {
    const isAhead = el.classList.contains('c-ahead');
    const key = isAhead ? 'ahead' : 'maxBlob';
    const lo = isAhead ? 1 : 2;
    const hi = isAhead ? MAX_AHEAD : MAX_KEEP;

    const raw = String(el.value || '').replace(/[^\d]/g, '');
    let v = parseInt(raw, 10);
    if (!Number.isFinite(v)) v = cfg[key];
    v = clamp(v, lo, hi);

    el.value = String(v);
    if (v === cfg[key]) { render(); return; }

    cfg[key] = v;
    saveCfg();
    render();
    if (isAhead) prefetch(); else maybePrune();
  }

  function isTyping(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function onKey(e) {
    if (!S.open) return;
    if (isTyping(e.target)) return;

    let handled = true;
    const rightForward = !cfg.tapSwap;

    switch (e.key) {
      case 'ArrowRight': case 'l': case 'L':
        if (rightForward) next(); else prev();
        break;
      case 'ArrowLeft': case 'h': case 'H':
        if (rightForward) prev(); else next();
        break;
      case 'PageDown': next(); break;
      case 'PageUp': prev(); break;
      case ' ':
        if (e.shiftKey) prev(); else next();
        break;
      case '[': gotoChapterDelta(-1); break;
      case ']': gotoChapterDelta(1); break;
      case 'c': case 'C':
        view.showPanel('chaps');
        view.showBars(true);
        break;
      case 'f': case 'F': {
        const order = ['contain', 'width', 'original'];
        setFit(order[(order.indexOf(cfg.fit) + 1) % order.length]);
        break;
      }
      case 's': case 'S': toggleSpread(); break;
      case 'w': case 'W': toggleStrip(); break;
      case '1': toggleSingle(); break;
      case 'm': case 'M': view.toggleBars(); break;
      case 't': case 'T': toggleTheme(); break;
      case '+': case '=': zoomStep(1); break;
      case '-': case '_': zoomStep(-1); break;
      case '0': resetZoom(); break;
      case 'Escape': {
        const r = view.refs;
        if (r && (!r.panel.hidden || !r.chaps.hidden)) { view.showPanel(null); break; }
        close();
        break;
      }
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onWheel(e) {
    if (!S.open) return;

    const t = e.target;
    if (t instanceof Element && t.closest('.c-panel')) return;

    if (cfg.wheel === 'zoom') {
      if (!e.deltaY) return;
      e.preventDefault();
      zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
      return;
    }

    if (e.ctrlKey || e.metaKey) return;

    // 条漫模式：滚轮就是纯滚动，别抢
    if (S.strip.on) return;

    // 画布里有东西可滚就先让它滚（条漫、放大后、原始尺寸都靠这条）；
    // 滚到头了才把这一格当成翻页，不然看长条会卡在页尾出不去。
    const stage = view.refs && view.refs.stage;
    if (stage) {
      const canY = stage.scrollHeight > stage.clientHeight + 2;
      const atTop = !canY || stage.scrollTop <= 1;
      const atBottom = !canY || stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      const down = e.deltaY > 0;
      if (!(down ? atBottom : atTop)) return;
    }

    e.preventDefault();
    const now = Date.now();
    if (now - view.lastWheel < 220) return;
    view.lastWheel = now;
    if (Math.abs(e.deltaY) < 1) return;
    if (e.deltaY > 0) next(); else prev();
  }

  function resetState() {
    S.at = null;
    S.ci = -1;
    S.idx = 0;
    S.images = [];
    S.total = 0;
    S.more = false;
    S.listLoading = false;
    S.step = 1;
    S.stepNav = 1;
    S.zoom = 1;
    S.dims = { l: null, r: null };
    S.gen++;
    S.view++;
    S.note = msg('note.preparing');
    S.noteKind = '';
    S.strip.on = !!cfg.strip;
    S.strip.items = [];
    S.strip.appending = false;
    S.strip.raf = 0;
    chCache.clear();
    chInflight.clear();
    imgUrl.clear();
    imgPending.clear();
    dl.q.length = 0;
    dl.queued.clear();
    view.chapSig = '';
    view.barSig = '';
  }

  // 目录：先看当前页有没有现成的，没有就让站点在 iframe 里渲染一份
  async function ensureChapters(detailUrl, currentChapterUrl) {
    const site = S.site;
    const token = S.gen;

    // 阅读页上找不到回作品页的链接：拿不到目录，当单话读就行，
    // 别把 null 塞进 fetchChapters 白等 25 秒
    if (!detailUrl) {
      S.listLoading = false;
      renderChaps('');
      return;
    }

    S.listLoading = true;
    renderChaps('');

    let list = [];
    try {
      list = await fetchChapters(detailUrl);
    } catch (e) { list = []; }

    if (token !== S.gen || !S.open) return;

    S.listLoading = false;

    if (!list.length) {
      list = fallbackChapters(currentChapterUrl, '');
      S.note = msg('note.noChapters');
    }

    S.book.chapters = list;
    const at = bare(currentChapterUrl);
    const hit = list.findIndex(c => bare(c.url) === at);
    S.ci = hit;

    if (hit < 0 && list.length === 1) S.ci = 0;

    view.chapSig = '';
    log('目录就绪 ' + list.length + ' 话 · 当前第 ' + (S.ci + 1) + ' 话');
    render();
    renderChaps(view.refs ? view.refs.find.value : '');
  }

  async function open(startUrl) {
    if (S.open) return;
    const url = new URL(startUrl || location.href);
    const site = detectSite(url);
    if (!site) return;

    const onChapter = site.isChapter(url.pathname);
    const onDetail = site.isDetail(url.pathname);
    if (!onChapter && !onDetail) return;

    // 目录页地址可能有标题尾巴（18comic），让站点归一成稳定的键
    let detailUrl;
    if (onChapter) {
      detailUrl = site.detailUrlOf(url, document);
    } else if (site.normDetail) {
      detailUrl = site.normDetail(url) || bare(url);
    } else {
      detailUrl = bare(url);
    }

    // E-Hentai 这种「一个画廊就是一话」的站：不需要目录
    if (site.single && !detailUrl) {
      log('没找到画廊地址，先不开');
      flashLauncher(msg('launch.noGallery'));
      return;
    }

    // 从目录页进来：先把章节列表拿到，拿不到就别开——开了也是空的
    let list = [];
    if (onDetail) {
      list = site.chaptersFromDoc(document, detailUrl);
      if (!list.length) {
        list = (await waitFor(() => {
          const l = site.chaptersFromDoc(document, detailUrl);
          return l.length ? l : null;
        }, 6000)) || [];
      }
      if (!list.length) {
        log('这个页面没读到章节列表，先不开：等页面加载完再按 V');
        flashLauncher(msg('launch.noList'));
        return;
      }
      writeListCache(detailUrl, list);
    }

    S.open = true;
    S.site = site;
    resetState();

    S.book = {
      title: site.bookTitle(document),
      detailUrl: detailUrl,
      chapters: []
    };

    view.build();
    syncLauncherTheme();
    view.el.dataset.theme = cfg.theme;
    view.showBars(false);

    document.addEventListener('keydown', blockSiteKeys, true);

    let startChapterUrl = null;
    let startIdx = 0;
    let resumed = false;

    if (site.single) {
      // 一话到底的站（E-Hentai）：画廊本身就是这一话，位置从页码换算
      S.book.chapters = [{ title: S.book.title || '画廊', url: bare(detailUrl) }];
      startChapterUrl = bare(detailUrl);
      startIdx = site.pageIndexOf ? site.pageIndexOf(url) : 0;
      S.ci = 0;
    } else if (onChapter) {
      startChapterUrl = bare(url);
      // 目录还没到时，先按「只有这一话」处理，读完再补上真正的目录
      S.book.chapters = fallbackChapters(startChapterUrl, '');
      S.ci = 0;
      S.listLoading = true;
    } else {
      S.book.chapters = list;
      startChapterUrl = list[0].url;

      // 上次读到哪里就接着读
      const pos = loadPos();
      if (pos) {
        const i = list.findIndex(c => sameUrl(c.url, pos.url));
        if (i >= 0) {
          startChapterUrl = list[i].url;
          startIdx = clamp(toInt(pos.idx, 0), 0, 99999);
          S.ci = i;
          resumed = true;
        }
      }
      if (S.ci < 0) S.ci = 0;
    }

    S.at = startChapterUrl;
    await openChapter(S.ci >= 0 ? S.ci : 0, startIdx);
    if (!S.open) return;

    // 目录比较慢（要从 iframe 里读），放到首屏之后
    if (!site.single && (onChapter || !S.book.chapters.length)) {
      ensureChapters(detailUrl, startChapterUrl);
    }

    setTimeout(() => { if (S.open) idbStat(); }, 800);

    if (resumed) {
      view.tip(msg('note.resume', { name: chapterTitle() || '', n: S.idx + 1 }));
      setTimeout(() => { if (S.open) view.tip(''); }, 4000);
    }

    log('v' + VERSION + ' 已打开 · ' + site.name + ' · ' + (onChapter ? '阅读页' : '目录页'));
  }

  const SITE_NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', ' ', '<', '>', ',', '.', 'Home', 'End'];

  function blockSiteKeys(e) {
    if (!S.open) return;
    if (isTyping(e.target)) return;
    if (SITE_NAV_KEYS.indexOf(e.key) >= 0) e.stopPropagation();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    S.view++;
    S.gen++;
    document.removeEventListener('keydown', blockSiteKeys, true);
    dl.q.length = 0;
    dl.queued.clear();

    const a = view.refs && view.refs.imgL;
    const b = view.refs && view.refs.imgR;
    if (a) dropUrl(a.getAttribute('src'));
    if (b) dropUrl(b.getAttribute('src'));
    stripClear();
    view.destroy();
    S.dims = { l: null, r: null };
    dropFrame();
    log('已关闭');
  }

  let launchEl = null;

  function detectTheme() {
    try {
      const nodes = [document.body, document.documentElement];
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!el) continue;
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i);
        if (!m) continue;
        const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (alpha < 0.5) continue;
        const lum = 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
        return lum < 120 ? 'dark' : 'light';
      }
    } catch (e) { /* 拿不到就按浅色 */ }
    return 'light';
  }

  function syncLauncherTheme() {
    if (launchEl) launchEl.dataset.theme = detectTheme();
  }

  // 入口按钮上闪一句话（打开失败时用，比弹窗轻）
  function flashLauncher(text) {
    if (!launchEl) return;
    const label = launchEl.querySelectorAll('span')[1];
    if (!label) return;
    const old = label.textContent;
    label.textContent = text;
    setTimeout(() => { if (label.isConnected) label.textContent = old; }, 2600);
  }

  function buildLauncher() {
    if (!cfg.launcher || launchEl) return;
    if (document.getElementById('cmv-launch')) return;
    const host = document.body || document.documentElement;
    if (!host) return;

    ensureStyle();

    const site = S.site || detectSite(new URL(location.href));
    const onDetail = site && site.isDetail(location.pathname);

    const btn = document.createElement('button');
    btn.id = 'cmv-launch';
    btn.type = 'button';
    btn.dataset.detail = onDetail ? '1' : '';
    btn.innerHTML = '<span class="c-l-dot"></span><span></span><span class="c-key">V</span>';
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      open(location.href);
    });
    host.appendChild(btn);
    launchEl = btn;
    syncLauncherText();
    syncLauncherTheme();
  }

  // 入口按钮上的字跟着语言走（换语言时也会调一次）
  function syncLauncherText() {
    if (!launchEl) return;
    const onDetail = !!launchEl.dataset.detail;
    const label = launchEl.querySelectorAll('span')[1];
    if (label) label.textContent = msg(onDetail ? 'launch.read' : 'launch.view');
    launchEl.title = msg(onDetail ? 'launch.titleRead' : 'launch.titleView');
  }

  function onSiteKey(e) {
    if (S.open) return;
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'v' && e.key !== 'V') return;
    if (document.getElementById('cmv')) return;
    e.preventDefault();
    open(location.href);
  }

  function main() {
    const site = detectSite(new URL(location.href));
    if (!site) return;

    const onChapter = site.isChapter(location.pathname);
    const onDetail = site.isDetail(location.pathname);
    if (!onChapter && !onDetail) return;

    S.site = site;
    buildLauncher();
    window.addEventListener('keydown', onSiteKey, true);

    log('v' + VERSION + ' 已就绪 · ' + site.name + ' · 点左下角按钮或按 V');

    // 别的脚本（或我们自己）把页面顶掉后，iframe 里的目录抓取仍在跑，别让它卡住
    window.addEventListener('pagehide', () => dropFrame());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }

})();
