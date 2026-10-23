/**
 * 助手发布控制器（无后台任务队列）：
 * 发布流程全部由侧边栏「助手」标签页驱动，操作对象 = 浏览器当前激活的标签页，
 * 任务配置（目标地址/网站介绍/主关键词）= 助手页顶部「当前任务」（state.assistantTask，
 * 可从 IndexedDB templates 表选模板填充）。
 *   步骤：获取标题与摘要 / AI 识别表单 / AI 生成评论 互不依赖、可任意顺序、可反复触发
 *   （同一步骤的并发触发由 stepBusy 去重）；「自动填写表单」需评论已生成，
 *   填表成功后进入 awaiting_review 等人工 Submit / Skip（此阶段步骤仍可重跑并覆盖重填）。
 *   Submit 成功写 published 表（按 [url, targetUrl] 防重复；不要求页面在资源库中，
 *   同行域名取面板「定位同行网站」输入框的值，空则回落会话 refDomain）；页面不在资源库时
 *   还会补录进 analysis 表当资源（ready，按同行域名归档），并把这次发布记进
 *   chrome.storage.local 的 lastPublish（url/目标地址/任务名/时间）；助手页底部「备注」
 *   随时给上次发布打标记（如「有审核」「失败」），不要求当前标签页还停在该资源页；
 *   Skip 仅清理页面标记；「标记为无效资源」停用 analysis 记录；
 *   「标注为已发过」不经提交流程，直接往 published 表补一条记录（已有同主键记录则拒绝）。
 *   「换一个」：把当前激活标签页导航到资源库中未发布过的下一条资源（ready 优先于 captcha）。
 *   助手页所需数据（状态文案/摘要/评论/译文/昵称/邮箱）全部落在 publishRuntime
 *   （rt.uiStatus / rt.manual），经快照广播给面板渲染；页面脚本只做无 UI 操作。
 *   绑定页面时的页面检测（验证码/登录/表单）是纯规则判定，不经 AI；
 *   检测到验证码只提示不阻断（人工可在页面里完成验证后继续执行步骤）。
 */
import { getState, addLog, domainOf } from '../lib/storage.js';
import { PUBLISH_SELECTORS } from '../lib/config.js';
import { idbGet, idbPut, idbPutAll, idbGetAll, idbDelete } from '../lib/idb.js';
import { fmtDateTime, samePageUrl } from '../lib/util.js';
import { detectForm, generateComment, generateIdentity, summarizeArticle, translateComment } from '../lib/openrouter.js';

/** AI 表单识别失败时的兜底选择器（WordPress 默认评论表单） */
function defaultForm() {
  return {
    comment: PUBLISH_SELECTORS.comment[0],
    author: PUBLISH_SELECTORS.author[0],
    email: PUBLISH_SELECTORS.email[0],
    url: PUBLISH_SELECTORS.website[0],
    submit: PUBLISH_SELECTORS.submit[0],
    saveInfo: PUBLISH_SELECTORS.saveInfo[0],
    linkMethod: 'website_field',
  };
}

/** 文章语言是否就是用户阅读语言（一致则评论译文没有存在必要，省下这次 AI 调用） */
function langMatches(artLang, target) {
  const a = String(artLang || '').toLowerCase();
  if (!a) return false;
  return target === 'en' ? /(en|英)/.test(a) : /(中|zh|chinese)/.test(a);
}

export class PublishAssistant {
  constructor(notify) {
    this.notify = notify;
    // 正在执行中的助手页步骤：按钮不置灰可重复点击，靠这里忽略同一步骤的并发触发
    this.stepBusy = new Set();
    // 插件主动导航时记下的「目标 URL → 同行域名」（立即发布/换一个）：bind 时优先用，
    // 页面跳转后 URL 变了也能对上来源；SW 回收会丢，此时靠 bind 里按 URL 查 analysis 兜底
    this.pendingRef = { url: '', domain: '' };
  }

  /** 当前激活标签页（助手页的默认操作对象）；非 http(s) 页面不可操作，返回 null */
  async activeTab() {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (!tab) {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    }
    return tab && /^https?:/.test(tab.url || '') ? tab : null;
  }

  /**
   * 获取可用于导航的当前标签页（立即发布 / 换一个）：
   * 不受限于当前是否为 http(s) 页面（chrome://newtab、空白页等均可被导航）；
   * 若提供 hintTabId 则优先使用，否则查询当前/最后聚焦窗口的激活标签页。
   */
  async navigableTab(hintTabId) {
    if (hintTabId && chrome.tabs?.get) {
      try {
        const t = await chrome.tabs.get(hintTabId);
        if (t && t.id) return t;
      } catch { /* 忽略无效或已关闭的 tabId */ }
    }
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (!tab || !tab.id) {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    }
    return tab && tab.id ? tab : null;
  }

  /** 当前任务配置：助手页「当前任务」字段，目标地址缺省回落到设置里的身份网址 */
  taskConfig() {
    const st = getState();
    const t = st.assistantTask || {};
    return {
      name: t.name || '',
      targetUrl: t.targetUrl || st.settings.identity.website || '',
      siteIntro: t.siteIntro || '',
      mainKeyword: t.mainKeyword || '',
    };
  }

  /**
   * 绑定激活标签页：publishRuntime 已指向该页面则复用；否则新建会话——
   * 全框架注入 publisher（评论框可能在 iframe 里）+ 纯规则页面检测（验证码/登录/表单），
   * 并确定 refDomain（「定位同行网站」参考的收集目标域名）：优先用插件导航时记下的
   * 同行域名（pendingRef，立即发布/换一个时已知来源），兜底按 URL 查 analysis 表。
   */
  async bind(tab) {
    const st = getState();
    const cur = st.publishRuntime;
    if (cur && cur.resourceUrl === tab.url) {
      cur.tabId = tab.id; // SW 回收后 tabId 可能过期，每次操作前刷新
      // 页面可能被站点整页重载过（如 WAF 浏览器校验通过后跳转），注入不存活于导航之后，
      // 每次操作前重新注入（幂等守卫，成本很低）
      await this.injectAll(tab.id).catch(() => {});
      return cur;
    }
    const rt = st.publishRuntime = {
      resourceUrl: tab.url,
      tabId: tab.id,
      stage: 'awaiting_steps',
      refDomain: '',
      uiStatus: { key: 'asstManual' },
      manual: { title: tab.title || '', excerpt: '', form: null, frameId: 0, comment: null, identity: null },
    };
    try {
      const rows = await idbGetAll('analysis');
      const hit = rows.find((r) => r && samePageUrl(r.url, tab.url));
      if (hit) rt.refDomain = hit.targetDomain || '';
    } catch { /* 查不到则面板「定位同行网站」会提示 */ }
    // 插件导航时已知的同行域名优先：跳转后 URL 变了、analysis 查不到也能对上来源
    if (this.pendingRef.url && this.pendingRef.domain && samePageUrl(this.pendingRef.url, tab.url)) {
      rt.refDomain = this.pendingRef.domain;
    }
    await this.injectAll(tab.id).catch(() => {});
    const d = await this.detectAll(tab.id).catch(() => null);
    if (st.publishRuntime !== rt) return rt; // 检测期间用户切到了别的页面
    if (!d) {
      rt.uiStatus = { text: '无法注入页面脚本（可能被反爬拦截），可尝试手动复制评论粘贴' };
    } else {
      rt.manual = { ...rt.manual, title: d.title || rt.manual.title, excerpt: d.excerpt, frameId: (d.forms[0] && d.forms[0].frameId) || 0 };
      if (d.hasCaptcha) {
        await this.markCaptcha(tab.url);
        rt.uiStatus = { key: 'asstCaptcha' };
        addLog('publish', '检测到验证码，已标记资源；可在页面中手动完成验证后继续执行步骤', 'warn', tab.url);
      } else if (d.loginRequired) {
        rt.uiStatus = { key: 'asstLogin' };
      } else if (!d.forms.length) {
        // 未找到表单不代表没有表单：可人工找到后点「识别表单」重试，或生成评论后复制手动粘贴
        rt.uiStatus = { key: 'asstNoForm' };
      }
    }
    // 同目标网址已在此页面发布过：提示避免重复评论（不阻断，用户显式操作仍可继续）
    const cfg = this.taskConfig();
    const pubRows = await idbGetAll('published').catch(() => []);
    const isAlreadyPub = cfg.targetUrl && pubRows.some((p) => p && p.targetUrl === cfg.targetUrl && (p.url === tab.url || samePageUrl(p.url, tab.url)));
    if (isAlreadyPub) {
      rt.uiStatus = { key: 'asstAlreadyPublished' };
    } else {
      // 频控检查与提示（每日同域名上限）
      const tabHost = (() => {
        try { return new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
      })();
      if (tabHost) {
        const oneDayAgo = Date.now() - 24 * 3600 * 1000;
        const sameDomainToday = pubRows.filter((p) => {
          if (!p || !p.url) return false;
          const d = (() => { try { return new URL(p.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })();
          const ts = typeof p.publishedAt === 'number' ? p.publishedAt : new Date(p.publishedAt).getTime();
          return d === tabHost && ts >= oneDayAgo;
        });
        const limit = st.settings.dailyPerDomain || 1;
        if (sameDomainToday.length >= limit) {
          rt.uiStatus = { text: `提示：域名「${tabHost}」今日已发布 ${sameDomainToday.length} 次（建议单日 ≤${limit}，优先发布新域名）` };
        }
      }
    }
    await this.notify(['publishRuntime', 'logs']);
    return rt;
  }

  /**
   * 发布成功：记入 published 表（已发过的外链，按 [url, targetUrl] 去重）。
   * 不要求 url 在资源库（analysis 表）中——手动打开的资源页同样落库；
   * targetDomain = 同行网站域名（面板「定位同行网站」输入框的值，空则回落会话 refDomain）。
   */
  async markPublished(url, targetUrl, taskName, targetDomain, linkChannel) {
    try {
      await idbPut('published', {
        url, targetUrl,
        targetDomain: targetDomain || '',
        taskName: taskName || '',
        publishedAt: fmtDateTime(),
        // 回访字段：T+10 分钟后由 verify.js 自动检查评论是否渲染、链接 rel 是什么
        verifyAt: Date.now() + 10 * 60 * 1000,
        verifyStage: 'pending',
        linkChannel: linkChannel || '',
      });
    } catch (e) {
      addLog('publish', `published 表写入失败：${e.message}`, 'warn', url);
    }
  }

  /** 发现验证码：把 analysis 表里的资源结论改为 captcha（保留 enabled 标记） */
  async markCaptcha(url) {
    try {
      const rows = await idbGetAll('analysis');
      const hit = rows.find((r) => r && r.url === url && r.status === 'ready');
      if (hit) await idbPut('analysis', { ...hit, status: 'captcha', reason: '发布时检测到验证码', checkedAt: Date.now() });
    } catch { /* 标记失败不影响主流程 */ }
  }

  /**
   * Submit 成功后把页面补录进资源库（analysis 表，结论 ready）：手动打开的资源页
   * 不在资源库里，发布成功即证明它是可用资源，按同行域名归档后资源库/「换一个」都能用上。
   * 同 url 已有记录（任意同行域名）则跳过；没有同行域名无法归档（主键 [targetDomain, url]），跳过并记日志。
   */
  async ensureAnalysisResource(url, targetDomain) {
    try {
      const rows = await idbGetAll('analysis');
      if (rows.some((r) => r && r.url === url)) return;
      if (!targetDomain) {
        addLog('publish', '页面不在资源库且未填写同行域名（「定位同行网站」右侧输入框），未补录进资源库', 'info', url);
        return;
      }
      await idbPut('analysis', { targetDomain, url, status: 'ready', reason: '发布成功补录（手动打开的资源页）', checkedAt: Date.now() });
      addLog('publish', `已把页面补录进资源库（同行：${targetDomain}）`, 'info', url);
    } catch (e) {
      addLog('publish', `资源库补录失败：${e.message}`, 'warn', url);
    }
  }

  /** 注入 publisher.js 到页面的所有框架（评论框可能在 iframe 里，如 Disqus）；个别框架不可注入时退回主框架 */
  async injectAll(tabId) {
    if (!chrome?.scripting) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/publisher.js'] });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/publisher.js'] });
    }
  }

  /**
   * 跨框架采集：在每个框架里执行 detect 并合并结果。
   * 标题/正文取主框架；表单候选跨框架合并并带上 frameId（后续填表/提交/高亮按 frameId 定向）；
   * 验证码与登录提示可能在 iframe 里，跨框架取并集。
   */
  async detectAll(tabId) {
    if (!chrome?.scripting) return null;
    const cfg = {
      func: (c) => window.__BCM_PUB__ && window.__BCM_PUB__.detect(c),
      args: [{ selectors: PUBLISH_SELECTORS }],
    };
    let results;
    try {
      results = await chrome.scripting.executeScript({ ...cfg, target: { tabId, allFrames: true } });
    } catch {
      // 个别框架无法注入时（如 chrome:// 子框架）退回只采主框架
      results = await chrome.scripting.executeScript({ ...cfg, target: { tabId } });
    }
    const frames = (results || []).filter((r) => r && r.result && r.result.ok);
    if (!frames.length) return null;
    const top = frames.find((r) => r.frameId === 0) || frames[0];
    const forms = [];
    for (const r of frames) {
      for (const f of r.result.forms || []) forms.push({ ...f, frameId: r.frameId });
    }
    forms.sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0));
    return {
      ok: true,
      title: top.result.title,
      excerpt: top.result.excerpt,
      forms: forms.slice(0, 3),
      hasCaptcha: frames.some((r) => r.result.hasCaptcha),
      loginRequired: frames.some((r) => r.result.loginRequired),
    };
  }

  /** 在表单所在框架里执行填表/提交/高亮（表单可能在 iframe 中） */
  async frameCall(tabId, frameId, fn, arg = null) {
    // args 必须可序列化：submit 这类无参调用不能传 undefined（会抛 Value is unserializable）
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      func: (f, a) => window.__BCM_PUB__ && window.__BCM_PUB__[f] && window.__BCM_PUB__[f](a),
      args: [fn, arg],
    });
    return res && res.result;
  }

  /** 标题与摘要：长正文先经 AI 提炼（语言由设置 summaryLang 决定）；失败退回原标题 + 原始摘录 */
  async summarize(url, title, excerpt) {
    try {
      const art = await summarizeArticle({ title, text: excerpt, lang: getState().settings.summaryLang || 'zh' });
      addLog('ai', `标题与摘要完成（${art.summary.length} 字）`, 'info', url);
      return art;
    } catch (e) {
      addLog('ai', `标题与摘要失败，改用原标题与原始摘录：${e.message}`, 'warn', url);
      return { title: title || '', summary: excerpt || '', language: '' };
    }
  }

  /**
   * 助手页步骤按钮回调：获取标题与摘要 / 识别表单 / 生成评论 / 填写表单。
   * 操作对象 = 当前激活标签页；rt.uiStatus / rt.manual 更新后 notify，由面板从快照渲染
   * （uiStatus.key 走 i18n 翻译，动态错误文本用 uiStatus.text 直显）。
   */
  async onStep(step) {
    if (!['summarize', 'detectForm', 'genComment', 'fill'].includes(step)) return { ok: false, error: '未知步骤' };
    // 同一步骤正在执行时忽略重复触发（面板按钮不置灰，防并发在这里兜底）
    if (this.stepBusy.has(step)) return { ok: true };
    const tab = await this.activeTab();
    if (!tab) return { ok: false, error: '当前标签页不是可操作的网页' };
    this.stepBusy.add(step);

    try {
      const rt = await this.bind(tab);
      const st = getState();
      const cfg = this.taskConfig();
      const url = tab.url;
      const m = rt.manual || {};
      // 步骤开始：先更新状态文案并广播，让面板立刻显示「进行中」
      const begin = async (key) => { rt.uiStatus = { key }; await this.notify(['publishRuntime']); };

      if (step === 'summarize') {
        // 获取标题与摘要：AI 按设置里的 summaryLang 输出，同时识别文章语言；展示到助手页（可复制）
        await begin('asstSummarizing');
        const art = await this.summarize(url, m.title, m.excerpt);
        rt.manual = { ...m, sumTitle: art.title, summary: art.summary, artLang: art.language };
        rt.uiStatus = { key: 'asstSumDone' };
      } else if (step === 'detectForm') {
        await begin('asstDetecting');
        // 重新采集页面表单候选（跨框架，标题/摘要一并刷新）；表单可能在 iframe 里，记住 frameId
        const d = await this.detectAll(tab.id).catch(() => null);
        const frameId = (d && d.forms.length && d.forms[0].frameId) || 0;
        const pageHost = (() => {
          try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
        })();

        // 表单指纹缓存：同站点第二次遇到直接复用选择器，跳过 AI 调用
        let form = null;
        const cached = pageHost && st.formIndex && st.formIndex[pageHost];
        if (cached && cached.selectors && cached.selectors.comment) {
          form = cached.selectors;
          cached.hits = (cached.hits || 0) + 1;
          await save('formIndex');
          addLog('publish', `命中表单指纹缓存，跳过 AI 识别（${pageHost}，累计命中 ${cached.hits} 次）`, 'info', url);
        } else if (d && d.ok && d.forms.length) {
          try {
            form = await detectForm({ formHtml: d.forms[0].html, pageUrl: url });
            if (!form || !form.comment) throw new Error('未识别到评论文本框');
            addLog('ai', `表单识别成功${frameId ? '（在 iframe 中）' : ''}（留链方式：${form.linkMethod || 'website_field'}）`, 'success', url);
            if (pageHost) {
              st.formIndex = st.formIndex || {};
              st.formIndex[pageHost] = {
                linkMethod: form.linkMethod || 'website_field',
                selectors: form,
                hits: 1,
                savedAt: Date.now(),
              };
              await save('formIndex');
            }
          } catch (e) {
            addLog('ai', `表单识别失败，使用默认选择器兜底：${e.message}`, 'warn', url);
            form = defaultForm();
          }
        } else {
          addLog('publish', '页面上未找到评论表单，跳过表单识别（生成评论后可从助手页复制手动填写）', 'warn', url);
        }
        rt.manual = { ...m, title: (d && d.title) || m.title, excerpt: (d && d.excerpt) || m.excerpt, form, frameId };
        // 滚动到识别出的表单并高亮（在表单所在框架执行），让人工确认 AI 的识别结果
        if (form) await this.frameCall(tab.id, frameId, 'markForm', form);
        rt.uiStatus = { key: form ? 'asstFormDone' : 'asstNoFormShort' };
      } else if (step === 'genComment') {
        // 不依赖表单识别结果：识别失败也照常生成评论，展示在助手页上供手动复制
        await begin('asstGenerating');
        // 标题与摘要优先复用「获取标题与摘要」的缓存；没点过则自动生成一次（同样缓存，
        // 反复点「生成评论」换一条时不会重复总结）
        const art = (m.summary != null && m.sumTitle != null)
          ? { title: m.sumTitle, summary: m.summary, language: m.artLang || '' }
          : await this.summarize(url, m.title, m.excerpt);
        const comment = await generateComment(
          { url, title: art.title, text: art.summary },
          {
            targetUrl: cfg.targetUrl,
            siteIntro: cfg.siteIntro,
            mainKeyword: cfg.mainKeyword,
            articleLang: art.language,
          },
        );
        addLog('ai', comment.includes('<a') ? '评论生成完成（正文内嵌链接）' : '评论生成完成', 'success', url);
        let identity;
        // 从设置里的身份邮箱取 @ 后面的域名，传给 AI 生成同域名邮箱（假邮箱被站点验证就废，且收不到评论通知）
        const ownerDomain = (() => {
          const em = st.settings.identity.email || '';
          const at = em.indexOf('@');
          return at > 0 ? em.slice(at + 1) : '';
        })();
        try {
          identity = await generateIdentity({ title: art.title, text: art.summary, ownerDomain });
          addLog('ai', `身份生成：${identity.name} <${identity.email}>`, 'info', url);
        } catch (e) {
          addLog('ai', `身份生成失败，使用设置里的默认身份：${e.message}`, 'warn', url);
          identity = { name: st.settings.identity.name, email: st.settings.identity.email };
        }
        // 独立网址框才是可靠留链通道：WordPress 对新访客的评论正文会做 HTML 过滤，<a> 多数被剥掉。
        // 是否真的填、正文要不要剥链接，由 publisher.js 的 fill() 按表单结构决定。
        identity.website = cfg.targetUrl || '';
        // 评论译文：仅展示给用户看（评论语言跟随文章，用户未必读得懂），不参与填表；
        // 文章语言与阅读语言一致时跳过；翻译失败不影响主流程
        let translation = '';
        const readLang = st.settings.summaryLang || 'zh';
        if (!langMatches(art.language, readLang)) {
          try {
            translation = await translateComment(comment, readLang);
          } catch (e) {
            addLog('ai', `评论译文生成失败（不影响发布）：${e.message}`, 'warn', url);
          }
        }
        // 评论/译文/昵称/邮箱全部落进 rt.manual，由助手页从快照渲染（每个字段带复制按钮）
        rt.manual = { ...m, sumTitle: art.title, summary: art.summary, artLang: art.language, comment, translation, identity };
        rt.uiStatus = { key: 'asstCommentDone' };
      } else if (step === 'fill') {
        if (!m.comment) throw new Error('请先生成评论，再执行「自动填写表单」');
        await begin('asstFilling');
        // 表单识别失败时用默认选择器兜底；仍填不进去可重试，或从助手页复制评论手动粘贴
        const form = m.form || defaultForm();
        const f = await this.frameCall(tab.id, m.frameId || 0, 'fill',
          { form, comment: m.comment, identity: m.identity, mode: 'semi', resourceUrl: url });
        if (!f || !f.ok) throw new Error((f && f.error) || '未知错误');
        addLog('publish', `表单已填入（正文:${f.filled.comment ? '✓' : '✗'} 昵称:${f.filled.author ? '✓' : '✗'} 邮箱:${f.filled.email ? '✓' : '✗'} 网址:${f.filled.website ? '✓' : '✗'}）`, 'info', url);
        // fill 成功后进入待确认阶段：面板按 stage === 'awaiting_review' 解锁 Submit / Skip
        rt.stage = 'awaiting_review';
        rt.uiStatus = { key: 'asstReady' };
        rt.manual = { ...m, linkChannel: f.linkChannel || '' };
      }
      await this.notify(['publishRuntime', 'logs']);
      return { ok: true };
    } catch (e) {
      addLog('publish', `步骤执行失败：${e.message}`, 'error', tab.url);
      const rt = getState().publishRuntime;
      if (rt && rt.resourceUrl === tab.url) rt.uiStatus = { text: `步骤失败：${e.message}` }; // 面板直显，可直接再点一次该步骤重试
      await this.notify(['publishRuntime', 'logs']);
      return { ok: false, error: e.message };
    } finally {
      this.stepBusy.delete(step);
    }
  }

  /**
   * 助手页 Submit / Skip 回调：仅 awaiting_review（表单已填好待确认）可执行。
   * domain = 面板「定位同行网站」输入框的同行域名（Submit 成功时写进 published 记录；
   * 当前页面不在资源库中时也照常落库，同行域名即取此输入框，空则回落会话 refDomain）。
   */
  async onDecision(decision, domain) {
    const tab = await this.activeTab();
    const rt = getState().publishRuntime;
    // 守卫拒绝必须给出具体原因并记日志：此前静默 {ok:false}，面板只能显示笼统的「超时/无响应」
    if (!tab || !rt || rt.resourceUrl !== tab.url || rt.stage !== 'awaiting_review') {
      const reason = !tab ? '当前标签页不是可操作的网页'
        : !rt ? '没有绑定的助手会话，请先执行「自动填写表单」'
        : rt.resourceUrl !== tab.url ? `当前标签页与绑定页面不一致（页面可能被重载/跳转，原绑定：${rt.resourceUrl}），请重新执行「自动填写表单」`
        : `当前不在待确认阶段（stage=${rt.stage}），请先执行「自动填写表单」`;
      addLog('publish', `Submit/Skip 被拒绝：${reason}`, 'warn', (tab && tab.url) || (rt && rt.resourceUrl) || '');
      await this.notify(['logs']);
      return { ok: false, error: reason };
    }
    const cfg = this.taskConfig();
    let submitted = false; // 提交成功标记：面板据此显示「备注」输入行

    if (decision === 'submit') {
      try {
        // 页面可能在填表后被重载过（WAF 校验/站点跳转）：提交前确保注入还在
        await this.injectAll(tab.id).catch(() => {});
        // 提交在表单所在框架执行（iframe 里的表单在对应框架提交）
        const s = await this.frameCall(tab.id, (rt.manual && rt.manual.frameId) || 0, 'submit');
        if (s && s.ok) {
          submitted = true;
          const refDomain = (domain || '').trim() || rt.refDomain || '';
          await this.markPublished(rt.resourceUrl, cfg.targetUrl, cfg.name, refDomain, rt.manual && rt.manual.linkChannel || '');
          // 页面不在资源库（手动打开的资源页）时补录为 ready 资源，之后资源库/「换一个」都能用上
          await this.ensureAnalysisResource(rt.resourceUrl, refDomain);
          // 记下「上次发布」：助手页备注按钮的标记对象（与当前标签页解耦，之后随时可改备注）
          getState().lastPublish = {
            url: rt.resourceUrl,
            targetUrl: cfg.targetUrl,
            taskName: cfg.name,
            publishedAt: fmtDateTime(),
            note: '',
          };
          addLog('publish', '✓ 人工确认，已提交', 'success', rt.resourceUrl);
          rt.uiStatus = { key: 'asstSubmitted' };
          // 已提交成功的评论作废：强制重新生成，避免页面刷新后误重复提交同一条
          rt.manual = { ...(rt.manual || {}), comment: null, translation: '', identity: null };
        } else {
          // 提交失败时表单已填好，保留 awaiting_review 让人工检查后再点 Submit 或手动提交
          addLog('publish', `✗ 提交失败：${(s && s.error) || '未知'}（表单内容仍在页面上，可检查后重试）`, 'error', rt.resourceUrl);
          rt.uiStatus = { text: `提交失败：${(s && s.error) || '未知'}，可直接在页面上检查后再点 Submit` };
          await this.notify(['publishRuntime', 'logs']);
          return { ok: true };
        }
      } catch (e) {
        addLog('publish', `✗ 提交异常：${e.message}`, 'error', rt.resourceUrl);
        rt.uiStatus = { text: `提交异常：${e.message}` };
        await this.notify(['publishRuntime', 'logs']);
        return { ok: true };
      }
    } else {
      addLog('publish', '⊘ 人工跳过', 'info', rt.resourceUrl);
      rt.uiStatus = { key: 'asstSkipped' };
    }

    try {
      // 表单高亮/链接标记可能在 iframe 里：全框架清理，恢复页面原样
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => window.__BCM_PUB__ && window.__BCM_PUB__.cleanup() });
    } catch { /* tab may be gone */ }

    // 停在当前页面，退回步骤阶段：可继续操作本页，或点「换一个」去下一条未发布资源
    rt.stage = 'awaiting_steps';
    await this.notify(['publishRuntime', 'lastPublish', 'logs']);
    return { ok: true, submitted };
  }

  /** 助手页「标记为无效资源」：把 analysis 表中当前激活标签页 url 的记录全部停用（enabled=false，数据保留）。不要求绑定会话，只认当前页面 */
  async markInvalid(domain, urlParam) {
    let url = (urlParam || '').trim();
    if (!url) {
      const tab = await this.activeTab();
      if (!tab) {
        return { ok: false, error: '当前没有可操作的网页标签页' };
      }
      url = tab.url;
    }
    try {
      const rows = await idbGetAll('analysis');
      const matches = rows.filter((r) => r && (r.url === url || samePageUrl(r.url, url)));
      if (matches.length > 0) {
        const dirty = matches.map((r) => ({ ...r, enabled: false }));
        await idbPutAll('analysis', dirty);
      } else {
        // 如果 analysis 表中尚无此记录（如手动浏览或未跑分析的页面）：
        // 自动补录一条 enabled=false 的记录，避免报错，同时在库中持久化记录为无效资源
        const allBacklinks = await idbGetAll('backlinks').catch(() => []);
        const bMatch = allBacklinks.find((b) => b && (b.url === url || samePageUrl(b.url, url)));
        const targetDomain = (domain || '').trim()
          || bMatch?.targetDomain
          || getState().publishRuntime?.refDomain
          || domainOf(url);

        const newRecord = {
          targetDomain,
          url,
          status: 'ready',
          type: 'other',
          enabled: false,
          reason: 'manual_invalid',
          checkedAt: Date.now(),
        };
        await idbPutAll('analysis', [newRecord]);
      }
      addLog('publish', '已标记为无效资源（enabled=false）', 'info', url);
      const rt = getState().publishRuntime;
      if (rt && (rt.resourceUrl === url || samePageUrl(rt.resourceUrl, url))) {
        rt.uiStatus = { key: 'asstInvalidMarked' };
        await this.notify(['publishRuntime', 'logs']);
      } else {
        await this.notify(['logs']);
      }
      return { ok: true };
    } catch (e) {
      addLog('publish', `标记无效资源失败：${e.message}`, 'error', url);
      return { ok: false, error: e.message };
    }
  }

  /** 助手页「恢复为有效资源」：把 analysis 表中当前激活标签页 url 的记录重新启用（enabled=true） */
  async markValid(urlParam) {
    let url = (urlParam || '').trim();
    if (!url) {
      const tab = await this.activeTab();
      if (!tab) {
        return { ok: false, error: '当前没有可操作的网页标签页' };
      }
      url = tab.url;
    }
    try {
      const rows = await idbGetAll('analysis');
      const matches = rows.filter((r) => r && (r.url === url || samePageUrl(r.url, url)));
      if (matches.length > 0) {
        const dirty = matches.map((r) => ({ ...r, enabled: true }));
        await idbPutAll('analysis', dirty);
      }
      addLog('publish', '已恢复为有效资源（enabled=true）', 'info', url);
      const rt = getState().publishRuntime;
      if (rt && (rt.resourceUrl === url || samePageUrl(rt.resourceUrl, url))) {
        rt.uiStatus = { key: 'asstValidRestored' };
        await this.notify(['publishRuntime', 'logs']);
      } else {
        await this.notify(['logs']);
      }
      return { ok: true };
    } catch (e) {
      addLog('publish', `恢复资源失败：${e.message}`, 'error', url);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 助手页「标注为已发过」：不经提交流程，直接往 published 表补一条记录（主键 [url, targetUrl]），
   * 用于人工确认「这个页面以前发过了」的防重复。目标地址取「当前任务」（缺省回落设置里的身份网址），
   * 同行域名 = 面板「定位同行网站」输入框的值，空则回落会话 refDomain；已有同主键记录则拒绝覆盖。
   */
  async markAsPublished(domain) {
    const tab = await this.activeTab();
    if (!tab) {
      return { ok: false, error: '当前没有可操作的网页标签页' };
    }
    const url = tab.url;
    const cfg = this.taskConfig();
    if (!cfg.targetUrl) {
      return { ok: false, error: '当前任务未配置目标地址（且设置里的身份网址为空），无法归档发布记录' };
    }
    try {
      const allPub = await idbGetAll('published').catch(() => []);
      const existing = allPub.find((p) => p && p.targetUrl === cfg.targetUrl && (p.url === url || samePageUrl(p.url, url)));
      if (existing) {
        return { ok: false, error: '该页面与当前目标地址已有发布记录' };
      }

      const rows = await idbGetAll('analysis').catch(() => []);
      const hit = rows.find((r) => r && samePageUrl(r.url, url));
      const canonUrl = hit ? hit.url : url;
      let rt = getState().publishRuntime;
      if (!rt || rt.resourceUrl !== url) {
        rt = await this.bind(tab);
      }
      const refDomain = (domain || '').trim() || (hit && hit.targetDomain) || (rt && rt.refDomain) || '';

      await this.markPublished(canonUrl, cfg.targetUrl, cfg.name, refDomain);
      if (canonUrl !== url) {
        await this.markPublished(url, cfg.targetUrl, cfg.name, refDomain);
      }
      if (!hit && refDomain) {
        await this.ensureAnalysisResource(canonUrl, refDomain);
      }
      addLog('publish', '已标注为已发过（记入 published 表）', 'info', canonUrl);

      if (rt) {
        rt.uiStatus = { key: 'asstPublishedMarked' };
      }
      // 记下「上次发布」：使助手页备注按钮可用
      getState().lastPublish = {
        url: canonUrl,
        targetUrl: cfg.targetUrl,
        taskName: cfg.name,
        publishedAt: fmtDateTime(),
        note: '',
      };
      await this.notify(['publishRuntime', 'lastPublish', 'logs']);
      return { ok: true };
    } catch (e) {
      addLog('publish', `标注为已发过失败：${e.message}`, 'error', url);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 助手页/资源库「取消标注为已发过」：从 published 表删除当前任务目标地址下的发布记录（主键 [url, targetUrl]）。
   * 支持传入指定 url（如来自资源库条目），未传则取当前激活标签页；
   * 会同时清理 samePageUrl 规范化匹配的历史记录。
   */
  async unmarkAsPublished(urlParam) {
    let url = (urlParam || '').trim();
    if (!url) {
      const tab = await this.activeTab();
      if (!tab) {
        return { ok: false, error: '当前没有可操作的网页标签页' };
      }
      url = tab.url;
    }
    const cfg = this.taskConfig();
    if (!cfg.targetUrl) {
      return { ok: false, error: '当前任务未配置目标地址，无法定位发布记录' };
    }
    try {
      const allPub = await idbGetAll('published').catch(() => []);
      const matches = allPub.filter((p) => p && p.targetUrl === cfg.targetUrl && (p.url === url || samePageUrl(p.url, url)));
      if (!matches.length) {
        return { ok: false, error: '未找到该页面在当前目标地址下的发布记录' };
      }
      for (const m of matches) {
        await idbDelete('published', [m.url, m.targetUrl]);
      }
      addLog('publish', '已取消标注为已发过（已从 published 表移除）', 'info', url);

      const rt = getState().publishRuntime;
      if (rt && (rt.resourceUrl === url || samePageUrl(rt.resourceUrl, url))) {
        rt.uiStatus = { key: 'asstPublishedUnmarked' };
      }
      await this.notify(['publishRuntime', 'logs']);
      return { ok: true };
    } catch (e) {
      addLog('publish', `取消标注失败：${e.message}`, 'error', url);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 助手页「将当前资源添加到资源库」：手动把当前激活标签页补录进 analysis 表（结论 ready），
   * 与 Submit 成功后的补录同口径。同行网站域名 = 面板「定位同行网站」右侧输入框的值（必填，
   * 主键 [targetDomain, url] 无法缺省归档）；同 url 已有记录（任意同行域名）视为已在资源库，不重复添加。
   */
  async addCurrentResource(domain) {
    const tab = await this.activeTab();
    if (!tab) {
      return { ok: false, error: '当前没有可操作的网页标签页' };
    }
    const url = tab.url;
    const targetDomain = (domain || '').trim();
    if (!targetDomain) {
      return { ok: false, error: '请先在「定位同行网站」右侧输入框填写同行网站域名' };
    }
    try {
      const rows = await idbGetAll('analysis');
      if (rows.some((r) => r && r.url === url)) {
        return { ok: false, error: '该页面已在资源库中' };
      }
      await idbPut('analysis', { targetDomain, url, status: 'ready', reason: '手动添加（助手页按钮）', checkedAt: Date.now() });
      addLog('publish', `已手动添加进资源库（同行：${targetDomain}）`, 'info', url);
      const rt = getState().publishRuntime;
      if (rt && rt.resourceUrl === url) {
        rt.uiStatus = { key: 'asstResourceAdded' };
        await this.notify(['publishRuntime', 'logs']);
      } else {
        await this.notify(['logs']);
      }
      return { ok: true };
    } catch (e) {
      addLog('publish', `手动添加资源库失败：${e.message}`, 'error', url);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 助手页「备注」：给上一次 Submit 成功的发布打标记（如「有审核」「失败」）。
   * 标记存在 chrome.storage.local 的 lastPublish 里（随快照下发展示），与当前标签页解耦——
   * 提交后跳到别的页面、甚至重开浏览器都能改；同时按记下的 [url, targetUrl] 尽力同步
   * published 表的 comment 字段（记录缺失或写失败不影响备注本身）。
   */
  async saveNote(note) {
    const lp = getState().lastPublish;
    if (!lp || !lp.url) return { ok: false, error: '还没有 Submit 成功的发布记录，无可备注的对象' };
    const text = String(note || '').trim();
    if (!text) return { ok: false, error: '备注内容为空' };
    getState().lastPublish = { ...lp, note: text };
    try {
      const row = await idbGet('published', [lp.url, lp.targetUrl]);
      if (row) await idbPut('published', { ...row, comment: text });
    } catch { /* published 表同步失败不影响备注保存 */ }
    addLog('publish', `上次发布备注已保存：${text}`, 'info', lp.url);
    await this.notify(['lastPublish', 'logs']);
    return { ok: true };
  }

  /**
   * 助手页「换一个」：把当前激活标签页导航到资源库中未发布过的下一条资源。
   * 口径与资源库一致：analysis 表命中结论（ready/captcha）且启用，且 published 表中
   * 对当前任务目标地址无记录；ready 优先于 captcha，同档按命中时间新→旧。
   */
  /** 资源库「立即发布」：当前激活标签页导航到指定资源，并记下该资源来自的同行域名（供 bind 使用） */
  /** 资源库「立即发布」：当前激活标签页导航到指定资源，并记下该资源来自的同行域名（供 bind 使用） */
  async navigateTo(url, refDomain, hintTabId) {
    if (!url) return { ok: false, error: '目标地址为空' };
    this.pendingRef = { url, domain: refDomain || '' };
    const tab = await this.navigableTab(hintTabId);
    let targetTabId = null;
    if (tab && tab.id) {
      try {
        await chrome.tabs.update(tab.id, { url, active: true });
        targetTabId = tab.id;
      } catch {
        // 当前标签页不可导航（如内部特殊页面禁止 update），新建标签页兜底
        const created = await chrome.tabs.create({ url, active: true }).catch(() => null);
        targetTabId = created ? created.id : null;
      }
    } else {
      const created = await chrome.tabs.create({ url, active: true }).catch(() => null);
      targetTabId = created ? created.id : null;
    }
    addLog('publish', '立即发布：已在标签页打开资源', 'info', url);
    await this.notify(['logs']);
    return { ok: true, url, tabId: targetTabId };
  }

  async pickNext(arg) {
    let targetOverride = '';
    let hintTabId = null;
    if (typeof arg === 'string' && /^https?:/.test(arg)) {
      targetOverride = arg;
    } else if (typeof arg === 'number') {
      hintTabId = arg;
    } else if (arg && typeof arg === 'object') {
      targetOverride = arg.targetUrl || '';
      hintTabId = arg.tabId || null;
    }

    const tab = await this.navigableTab(hintTabId);
    const curUrl = tab ? (tab.url || '') : '';
    const [analysis, published, blacklist] = await Promise.all([
      idbGetAll('analysis').catch(() => []),
      idbGetAll('published').catch(() => []),
      idbGetAll('blacklist').catch(() => []),
    ]);
    const target = targetOverride || this.taskConfig().targetUrl;
    const targetPublished = published.filter((r) => r && r.targetUrl === target);
    const pubUrls = new Set(targetPublished.map((r) => r.url));
    const isPublishedUrl = (u) => pubUrls.has(u) || targetPublished.some((p) => samePageUrl(p.url, u));
    const blackSet = new Set(blacklist.map((b) => b.domain));
    const settings = getState().settings || {};

    const now = Date.now();
    const oneDayAgo = now - 24 * 3600 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

    // 统计各博客域名的发布历史（频控与横向优先）
    const domainPubStats = new Map();
    for (const p of published) {
      if (!p || !p.url) continue;
      const d = (() => {
        try { return new URL(p.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
      })();
      if (!d) continue;
      const stat = domainPubStats.get(d) || { totalPub: 0, dailyCount: 0, weeklyCount: 0 };
      stat.totalPub++;
      const pubTs = typeof p.publishedAt === 'number' ? p.publishedAt : new Date(p.publishedAt).getTime();
      if (pubTs) {
        if (pubTs >= oneDayAgo) stat.dailyCount++;
        if (pubTs >= sevenDaysAgo) stat.weeklyCount++;
      }
      domainPubStats.set(d, stat);
    }

    const seen = new Set();
    const candidates = analysis
      .filter((r) => {
        if (!r || !r.url || r.enabled === false) return false;
        if ((curUrl && (r.url === curUrl || samePageUrl(r.url, curUrl))) || isPublishedUrl(r.url)) return false;
        // 遇到验证码直接跳过（可由 settings.skipOnCaptcha 控制）
        if (settings.skipOnCaptcha !== false && r.status === 'captcha') return false;
        if (r.status !== 'ready' && r.status !== 'captcha') return false;

        const host = (() => {
          try { return new URL(r.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
        })();
        // 黑名单过滤
        if (blackSet.has(host)) return false;

        // 频控过滤：单日上限与 7 天上限
        const stat = domainPubStats.get(host);
        if (stat) {
          const dailyLimit = settings.dailyPerDomain ?? 1;
          const weeklyLimit = settings.weeklyPerDomain ?? 2;
          if (dailyLimit > 0 && stat.dailyCount >= dailyLimit) return false;
          if (weeklyLimit > 0 && stat.weeklyCount >= weeklyLimit) return false;
        }
        return true;
      })
      .filter((r) => !seen.has(r.url) && seen.add(r.url))
      .sort((a, b) => {
        const da = (() => { try { return new URL(a.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })();
        const db = (() => { try { return new URL(b.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })();
        const statA = domainPubStats.get(da) || { totalPub: 0 };
        const statB = domainPubStats.get(db) || { totalPub: 0 };

        // 1. 横向优先：从未发布过的域名排在最前，发过较多的同域名降权
        if (statA.totalPub !== statB.totalPub) {
          return statA.totalPub - statB.totalPub;
        }
        // 2. 状态优先：ready 优于 captcha
        const readyDiff = (a.status === 'ready' ? 0 : 1) - (b.status === 'ready' ? 0 : 1);
        if (readyDiff !== 0) return readyDiff;
        // 3. 时间优先：最新命中优先
        return (b.checkedAt || 0) - (a.checkedAt || 0);
      });

    if (!candidates.length) return { ok: false, error: '资源库中没有符合频控条件的未发布资源了' };
    const url = candidates[0].url;
    this.pendingRef = { url, domain: candidates[0].targetDomain || '' };
    let targetTabId = null;
    if (tab && tab.id) {
      try {
        await chrome.tabs.update(tab.id, { url, active: true });
        targetTabId = tab.id;
      } catch {
        const created = await chrome.tabs.create({ url, active: true }).catch(() => null);
        targetTabId = created ? created.id : null;
      }
    } else {
      const created = await chrome.tabs.create({ url, active: true }).catch(() => null);
      targetTabId = created ? created.id : null;
    }
    addLog('publish', '换一个：已在标签页打开下一条未发布资源（横向优先排序）', 'info', url);
    await this.notify(['logs']);
    return { ok: true, url, domain: candidates[0].targetDomain || '', tabId: targetTabId };
  }
}
