/**
 * MV3 Service Worker：消息路由 + 状态快照广播 + 保活与断点续跑。
 */
import {
  load, getState, save, clearAll, addLog, domainOf,
} from '../lib/storage.js';
import {
  backlinksCsv, waitTabComplete, sleep, parseSiteMetadata, ruleExtractSiteInfo, samePageUrl,
} from '../lib/util.js';
import { idbGet, idbGetDomain, idbGetAll, idbPut, idbPutAll, idbDelete } from '../lib/idb.js';
import { CollectController } from './collect.js';
import { PublishAssistant } from './publish.js';
import { testKey, extractSiteInfoAI } from '../lib/openrouter.js';
import { runVerifyDue } from './verify.js';

const ALARM_TICK = 'bcm-tick';
const ALARM_SPAM_CLEAN = 'bcm-spam-clean';

// 点击工具栏图标直接打开侧边栏（无 popup）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
  console.error('[BCM] sidePanel behavior error', e);
});

let collect, publish;

function ensureControllers() {
  // 控制器统一以 notify(['a','b']) 数组形式传 key；此处展开后交给 save
  const notify = async (keys = []) => {
    await save(...keys);
    broadcast();
  };
  if (!collect) collect = new CollectController(notify);
  if (!publish) publish = new PublishAssistant(notify);
}

/** 当前「当前任务」的目标地址（与发布口径一致：缺省回落到设置里的身份网址） */
function taskTargetUrl(st = getState()) {
  return (st.assistantTask && st.assistantTask.targetUrl) || st.settings.identity.website || '';
}

/** 「已发布」按当前任务判定：published 表中存在 [url, 当前任务目标地址] 记录才算已发布 */
function publishedUrlSet(published, st) {
  const target = taskTargetUrl(st);
  return new Set(published.filter((r) => r && r.targetUrl === target).map((r) => r.url));
}

async function snapshot() {
  const st = getState();
  // 可用资源 = analysis 表命中结论的记录（不经内存态）；同一 url 可能被多个目标域名收集到，按 url 去重合并：
  // 任一记录停用即停用，对当前任务目标地址发布过即标 published
  const [analysis, published, seeds, blacklist] = await Promise.all([
    idbGetAll('analysis').catch(() => []),
    idbGetAll('published').catch(() => []),
    idbGetAll('seeds').catch(() => []),
    idbGetAll('blacklist').catch(() => []),
  ]);
  const target = taskTargetUrl(st);
  const pubMap = new Map();
  for (const p of published) {
    if (p && p.url && p.targetUrl === target) {
      pubMap.set(p.url, p);
    }
  }
  const publishedUrls = new Set(pubMap.keys());
  const blackSet = new Set(blacklist.map((b) => b.domain));
  const hits = analysis
    .filter((r) => r && r.url && VALID_STATUSES.includes(r.status))
    .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)); // 新命中的在前
  const byUrl = new Map();
  for (const r of hits) {
    const cur = byUrl.get(r.url);
    const pub = pubMap.get(r.url);
    const host = domainOf(r.url);
    const isBlacklisted = blackSet.has(host);
    if (!cur) {
      byUrl.set(r.url, {
        url: r.url,
        domain: host,
        status: r.status,
        enabled: !isBlacklisted && r.enabled !== false, // 黑名单强制停用
        published: publishedUrls.has(r.url),
        verifyStage: pub?.verifyStage || '',
        rel: pub?.rel || '',
        isBlacklisted,
        checkedAt: r.checkedAt,
      });
    } else {
      cur.enabled = cur.enabled && !isBlacklisted && r.enabled !== false;
      cur.published = cur.published || publishedUrls.has(r.url);
      if (pub?.verifyStage) cur.verifyStage = pub.verifyStage;
      if (pub?.rel) cur.rel = pub.rel;
    }
  }
  const resources = [...byUrl.values()];
  return {
    collect: {
      status: st.collectState.status,
      mode: st.collectState.mode || 'collect',
      targetDomain: st.collectState.targetDomain,
      provider: st.collectState.provider,
      phase: st.collectState.phase,
      discovered: st.collectState.discovered,
      analyzed: st.collectState.analyzed,
      matched: st.collectState.matched,
      queued: st.collectState.queued,
      seeds: seeds.length,
      newSeeds: seeds.filter((s) => s.status !== 'used').length,
      blacklistCount: blacklist.length,
    },
    // 助手页顶部「当前任务」配置（目标地址/网站介绍/主关键词）
    assistantTask: { ...st.assistantTask },
    // 助手页（对当前激活标签页的人工交互）所需的全部数据随快照下发：uiStatus.key 由面板经
    // i18n 翻译，动态错误文本用 uiStatus.text；manual 里 name/email 从 identity 展开。
    // 面板按 publish.resourceUrl 与当前激活标签页 URL 是否一致决定字段区与 Submit/Skip 是否生效
    publish: st.publishRuntime
      ? {
          resourceUrl: st.publishRuntime.resourceUrl,
          stage: st.publishRuntime.stage,
          refDomain: st.publishRuntime.refDomain || '',
          uiStatus: st.publishRuntime.uiStatus || null,
          manual: (() => {
            const m = st.publishRuntime.manual || {};
            const id = m.identity || {};
            return {
              sumTitle: m.sumTitle || '', summary: m.summary || '', artLang: m.artLang || '',
              comment: m.comment || '', translation: m.translation || '',
              name: id.name || '', email: id.email || '',
            };
          })(),
        }
      : null,
    // 插件最近一次主动导航的「目标 URL → 同行域名」（资源库立即发布/换一个）：
    // 绑定会话建立前面板也能据此把同行域名预填进「定位同行网站」输入框
    pendingRef: (publish && publish.pendingRef) || { url: '', domain: '' },
    // 上次 Submit 成功的发布（助手页「备注」的标记对象，与当前标签页解耦）
    lastPublish: st.lastPublish ? { ...st.lastPublish } : null,
    resources,
    logs: st.logs.slice(-200).reverse(),
    settings: {
      language: st.settings.language,
      hasKey: !!st.settings.openrouterKey,
      pageDelayMinMs: st.settings.pageDelayMinMs,
      pageDelayMaxMs: st.settings.pageDelayMaxMs,
      minAscore: st.settings.minAscore,
      logEnabled: st.settings.logEnabled !== false,
      aiTimeoutMs: st.settings.aiTimeoutMs, // 助手页步骤按钮看门狗用（aiTimeoutMs * 3 + 30000）
      autoSpamClean: st.settings.autoSpamClean !== false,
      spamCleanIntervalHours: st.settings.spamCleanIntervalHours || 24,
      lastSpamCleanAt: st.settings.lastSpamCleanAt || 0,
    },
  };
}

async function broadcast() {
  const msg = { type: 'stateChanged', snapshot: await snapshot() };
  // 无连接单向广播给扩展页面（sidepanel）：不依赖长连接，SW 重启换新实例后照样送达；
  // 面板未打开时无人接收，静默忽略
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function ensureAlarm(on) {
  if (on) {
    chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  } else {
    chrome.alarms.clear(ALARM_TICK);
  }
}

async function isIdle() {
  if (getState().collectState.status !== 'idle') return false;
  const rows = await idbGetAll('published').catch(() => []);
  return !rows.some((r) => r && r.verifyAt && r.verifyStage !== 'done' && r.verifyStage !== 'dead');
}

/**
 * 空闲时把收集统计刷新为 IndexedDB 存量口径（跨轮次累积）：
 * 已发现 = backlinks 表条数；已分析 = analysis 表条数；
 * 队列中 = backlinks 里未分析过的；博客评论资源 = analysis 中命中结论（ready/captcha，与资源库筛选一致）条数。
 */
const VALID_STATUSES = ['ready', 'captcha'];
// Chrome 在插件重载后会两次创建 side panel 文档（恢复 + 附着），每次都会发 getSnapshot；
// 短时间内的重复触发去抖，只跑一次
const STATS_REFRESH_DEBOUNCE_MS = 3000;
let lastStatsRefreshAt = 0;
export function resetStatsRefreshDebounce() { lastStatsRefreshAt = 0; } // 测试用
async function refreshCollectStatsFromIdb() {
  if (Date.now() - lastStatsRefreshAt < STATS_REFRESH_DEBOUNCE_MS) return;
  lastStatsRefreshAt = Date.now();
  const st = getState();
  const c = st.collectState;
  if (c.status !== 'idle') {
    addLog('collect', `统计刷新跳过：status=${c.status}`, 'warn');
    await save('logs');
    return;
  }
  try {
    // targetDomain 丢失时（如旧版 save 覆盖写 bug 抹掉持久化状态）从 IndexedDB 恢复最近收集的域名
    if (!c.targetDomain) {
      const all = await idbGetAll('backlinks');
      if (all.length) {
        all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        c.targetDomain = all[0].targetDomain;
        addLog('collect', `目标域名丢失，已从收集数据恢复：${c.targetDomain}`, 'warn');
        await save('collectState');
      }
    }
    if (!c.targetDomain) {
      addLog('collect', '统计刷新跳过：无目标域名且收集数据为空', 'warn');
      await save('logs');
      return;
    }
    const [links, analysis] = await Promise.all([
      idbGetDomain('backlinks', c.targetDomain),
      idbGetDomain('analysis', c.targetDomain),
    ]);
    const analyzedUrls = new Set(analysis.map((r) => r.url));
    const next = {
      discovered: links.length,
      analyzed: analysis.length,
      queued: links.filter((r) => !analyzedUrls.has(r.url)).length,
      matched: analysis.filter((r) => VALID_STATUSES.includes(r.status)).length,
      seen: links.map((r) => r.url),
    };
    addLog('collect', `统计刷新（${c.targetDomain}）：已发现=${next.discovered} / 已分析=${next.analyzed} / 队列中=${next.queued} / 博客评论资源=${next.matched}`, 'info');
    if (c.discovered !== next.discovered || c.analyzed !== next.analyzed
      || c.queued !== next.queued || c.matched !== next.matched) {
      Object.assign(c, next);
      await save('collectState', 'logs');
      broadcast();
    } else {
      await save('logs');
    }
  } catch (e) {
    addLog('collect', `统计刷新失败：${e.message}`, 'error');
    await save('logs');
  }
}

// ---------------- Spam 清洗辅助函数 ----------------

/** 直接调用 seo.web.cafe/spam/ 接口批量检测域名是否为 Spam */
async function checkSpamDomainsDirectly(domains) {
  if (!domains || !domains.length) return { ok: false, error: '没有需要查询的域名' };
  try {
    const htmlRes = await fetch('https://seo.web.cafe/spam/', { cache: 'no-store' });
    if (!htmlRes.ok) throw new Error('无法访问 Spam 工具页 (HTTP ' + htmlRes.status + ')');
    const html = await htmlRes.text();
    const tokenMatch = html.match(/name="spam-token"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+name="spam-token"/i);
    const token = tokenMatch ? tokenMatch[1] : '';
    if (!token) throw new Error('未获取到工具页面 spam-token');

    const spamDomains = [];
    const cleanDomains = [];
    const unknownDomains = [];
    const CHUNK = 50;

    for (let i = 0; i < domains.length; i += CHUNK) {
      const slice = domains.slice(i, i + CHUNK);
      const res = await fetch('https://seo.web.cafe/spam/api/lookup-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SPAM-Token': token,
        },
        body: JSON.stringify({ domains: slice }),
      });
      if (!res.ok) throw new Error('Spam 接口请求失败 (HTTP ' + res.status + ')');
      const data = await res.json();
      for (const item of (data.results || [])) {
        if (!item || !item.domain) continue;
        if (!item.known) {
          unknownDomains.push(item.domain);
        } else if (item.isSpam) {
          spamDomains.push(item.domain);
        } else {
          cleanDomains.push(item.domain);
        }
      }
    }
    return {
      ok: true,
      total: domains.length,
      spamDomains,
      cleanDomains,
      unknownDomains,
    };
  } catch (e) {
    return { ok: false, error: e.message, fallback: true };
  }
}

/** 打开 seo.web.cafe/spam/ 页面并自动填入域名列表提交查询 */
async function openSpamPageWithDomains(domains) {
  const text = domains.join('\n');
  const tab = await chrome.tabs.create({ url: 'https://seo.web.cafe/spam/', active: true });
  await waitTabComplete(tab.id, 20000);
  await sleep(800);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (content) => {
      const ta = document.getElementById('domain');
      if (ta) {
        ta.value = content;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const form = document.getElementById('qform');
        if (form) {
          if (form.requestSubmit) form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      }
    },
    args: [text],
  }).catch(() => {});
  return { ok: true, tabId: tab.id };
}

/** 定期自动从资源库及外链库提取全部域名并比对 seo.web.cafe/spam/ 接口，自动更新黑名单并停用垃圾资源 */
export async function runPeriodicSpamClean(force = false) {
  const st = getState();
  const s = st.settings || {};
  if (!s.autoSpamClean && !force) return { ok: false, reason: 'disabled' };

  const intervalMs = (Number(s.spamCleanIntervalHours) || 24) * 3600 * 1000;
  const lastAt = Number(s.lastSpamCleanAt) || 0;
  if (!force && Date.now() - lastAt < intervalMs) {
    return { ok: false, reason: 'not_due', lastAt, intervalMs };
  }

  const [analysis, backlinks, blacklist] = await Promise.all([
    idbGetAll('analysis').catch(() => []),
    idbGetAll('backlinks').catch(() => []),
    idbGetAll('blacklist').catch(() => []),
  ]);

  const blackSet = new Set(blacklist.map((b) => b.domain));
  const candidateDomains = new Set();
  for (const r of analysis) {
    if (r && r.url) {
      const h = domainOf(r.url);
      if (h && !blackSet.has(h)) candidateDomains.add(h);
    }
  }
  for (const r of backlinks) {
    if (r && r.url) {
      const h = domainOf(r.url);
      if (h && !blackSet.has(h)) candidateDomains.add(h);
    }
  }

  const domains = [...candidateDomains];
  if (!domains.length) {
    addLog('system', 'Spam 定期清洗：无待检测域名（库为空或已全部在黑名单）', 'info');
    s.lastSpamCleanAt = Date.now();
    await save('settings', 'logs');
    return { ok: true, total: 0, spamCount: 0 };
  }

  addLog('system', `Spam 定期清洗开始：共 ${domains.length} 个未拉黑域名待检测`, 'info');
  const res = await checkSpamDomainsDirectly(domains);
  s.lastSpamCleanAt = Date.now();
  await save('settings');

  if (!res.ok) {
    addLog('system', `Spam 定期清洗失败：${res.error}`, 'warn');
    await save('logs');
    return res;
  }

  const spamDomains = res.spamDomains || [];
  let disabledCount = 0;
  if (spamDomains.length) {
    const now = Date.now();
    for (const d of spamDomains) {
      await idbPut('blacklist', {
        domain: d,
        reason: 'Ahrefs 定期检测判定为垃圾外链域名 (Is spam)',
        source: 'periodic_spam_tool',
        addedAt: now,
      });
    }
    for (const a of analysis) {
      if (!a || !a.url) continue;
      const h = domainOf(a.url);
      if (spamDomains.includes(h) && a.enabled !== false) {
        a.enabled = false;
        a.reason = '已自动停用（Ahrefs 定期检测为垃圾外链域名）';
        await idbPut('analysis', a);
        disabledCount++;
      }
    }
  }

  addLog('system', `Spam 定期清洗完成：排查 ${domains.length} 个域名，发现垃圾域名 ${spamDomains.length} 个${disabledCount ? `，已自动停用 ${disabledCount} 条资源` : ''}`, spamDomains.length ? 'warn' : 'success');
  await save('logs');
  broadcast();
  return {
    ok: true,
    total: domains.length,
    spamCount: spamDomains.length,
    cleanCount: (res.cleanDomains || []).length,
    disabledCount,
  };
}

// ---------------- 消息处理 ----------------

async function handleMessage(msg, sender) {
  await load();
  ensureControllers();

  switch (msg.type) {
    // ---- Popup 拉取与控制 ----
    case 'getSnapshot':
      await refreshCollectStatsFromIdb();
      return { ok: true, snapshot: await snapshot() };

    case 'startCollect':
      await collect.start(msg.domain, msg.provider);
      ensureAlarm(true);
      return { ok: true, snapshot: await snapshot() };

    case 'stopCollect':
      await collect.stop();
      if (isIdle()) ensureAlarm(false);
      return { ok: true, snapshot: await snapshot() };

    case 'startAnalysis':
      await collect.startAnalysis();
      ensureAlarm(true);
      return { ok: true, snapshot: await snapshot() };

    // ---- 助手页「当前任务」配置（生成的评论内嵌链接吃这里的 targetUrl/siteIntro/mainKeyword）----
    case 'setAssistantTask': {
      getState().assistantTask = {
        name: (msg.name || '').trim(),
        targetUrl: (msg.targetUrl || '').trim(),
        siteIntro: (msg.siteIntro || '').trim(),
        mainKeyword: (msg.mainKeyword || '').trim(),
      };
      await save('assistantTask');
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    // 助手页「当前任务」：根据目标网址自动抓取并提取网站名称、介绍、主关键词（AI 优先，规则兜底）
    case 'extractSiteInfo': {
      let rawUrl = (msg.url || '').trim();
      if (!rawUrl) return { ok: false, error: '目标网址不能为空' };
      if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;

      let parsedMeta = null;

      // 1. 若当前激活标签页正好是该网址，优先通过 DOM 提取（支持 SPA 渲染后的完整 DOM）
      try {
        if (typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
          let targetTabId = msg.tabId;
          if (!targetTabId && chrome.tabs?.query) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab && activeTab.id && activeTab.url && samePageUrl(activeTab.url, rawUrl)) {
              targetTabId = activeTab.id;
            }
          }
          if (targetTabId) {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId: targetTabId, frameIds: [0] },
              func: () => {
                const q = (sel) => document.querySelector(sel)?.content || '';
                const title = (document.querySelector('title')?.textContent || document.title || '').trim();
                const siteName = q('meta[property="og:site_name"]') || q('meta[name="application-name"]');
                const description = q('meta[name="description"]') || q('meta[property="og:description"]') || q('meta[name="twitter:description"]');
                const keywords = q('meta[name="keywords"]') || q('meta[name="news_keywords"]');
                const bodyClone = document.body ? document.body.cloneNode(true) : null;
                if (bodyClone) {
                  bodyClone.querySelectorAll('script,style,noscript,svg,nav,header,footer').forEach((el) => el.remove());
                }
                const text = (bodyClone?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000);
                return { title, siteName, description, keywords, text };
              },
            });
            if (res && res.result && (res.result.title || res.result.text)) {
              parsedMeta = { url: rawUrl, ...res.result };
            }
          }
        }
      } catch {
        // executeScript 失败或不可注入，继续走 HTTP fetch
      }

      // 2. 如果未能从 DOM 读取，后台 fetch(rawUrl)
      if (!parsedMeta) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15000);
          const resp = await fetch(rawUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const html = await resp.text();
          parsedMeta = parseSiteMetadata(html, rawUrl);
        } catch (e) {
          addLog('system', `获取网站内容失败(${rawUrl}): ${e.message}`, 'warn', rawUrl);
          return { ok: false, error: `无法获取目标网站内容：${e.message}` };
        }
      }

      const st = getState();
      let taskData = null;
      let usedMode = 'rule';
      const reqMode = msg.mode || 'auto';

      if (reqMode === 'rule') {
        // 纯程序导入：直接由规则从 DOM/HTML 提取原标题、描述与关键词，不走 AI
        const ruleData = ruleExtractSiteInfo(parsedMeta);
        taskData = {
          name: ruleData.name,
          targetUrl: rawUrl,
          siteIntro: ruleData.siteIntro,
          mainKeyword: ruleData.mainKeyword,
        };
        usedMode = 'rule';
        addLog('system', `网站信息程序直接导入完成：${taskData.name || rawUrl}`, 'info', rawUrl);
      } else if (reqMode === 'ai') {
        // AI 导入：使用 AI 进行提炼，未配置 Key 或失败明确提示
        if (!st.settings?.openrouterKey) {
          return { ok: false, error: '未配置 OpenRouter API Key，请先到设置页填写或使用「程序导入」' };
        }
        try {
          const aiResult = await extractSiteInfoAI({
            ...parsedMeta,
            lang: st.settings?.summaryLang || st.settings?.language || 'zh',
          });
          taskData = {
            name: aiResult.name || parsedMeta.siteName || '',
            targetUrl: rawUrl,
            siteIntro: aiResult.siteIntro || parsedMeta.description || '',
            mainKeyword: aiResult.mainKeyword || '',
          };
          usedMode = 'ai';
          addLog('ai', `网站信息 AI 智能提炼成功：${taskData.name || rawUrl}`, 'info', rawUrl);
        } catch (e) {
          addLog('ai', `网站信息 AI 提炼失败: ${e.message}`, 'warn', rawUrl);
          return { ok: false, error: `AI 智能提炼失败: ${e.message}` };
        }
      } else {
        // 自动/混合模式（兼容单测与旧调用）：AI 优先，规则兜底
        if (st.settings?.openrouterKey) {
          try {
            const aiResult = await extractSiteInfoAI({
              ...parsedMeta,
              lang: st.settings?.summaryLang || st.settings?.language || 'zh',
            });
            taskData = {
              name: aiResult.name || parsedMeta.siteName || '',
              targetUrl: rawUrl,
              siteIntro: aiResult.siteIntro || parsedMeta.description || '',
              mainKeyword: aiResult.mainKeyword || '',
            };
            usedMode = 'ai';
            addLog('ai', `网站信息 AI 智能提取成功：${taskData.name || rawUrl}`, 'info', rawUrl);
          } catch (e) {
            addLog('ai', `网站信息 AI 提取失败，降级为规则提取: ${e.message}`, 'warn', rawUrl);
          }
        }
        if (!taskData) {
          const ruleData = ruleExtractSiteInfo(parsedMeta);
          taskData = {
            name: ruleData.name,
            targetUrl: rawUrl,
            siteIntro: ruleData.siteIntro,
            mainKeyword: ruleData.mainKeyword,
          };
          usedMode = 'rule';
          addLog('system', `网站信息规则提取完成：${taskData.name || rawUrl}`, 'info', rawUrl);
        }
      }

      // 5. 保存至 assistantTask 并广播快照
      st.assistantTask = taskData;
      await save('assistantTask', 'logs');
      broadcast();

      return {
        ok: true,
        task: taskData,
        mode: usedMode,
        snapshot: await snapshot(),
      };
    }

    // 资源库：直接读 IndexedDB analysis 表，取命中结论（ready/captcha，验证码资源也算命中）的记录（不经内存态）
    case 'getLibraryResources': {
      const [rows, published, blacklist] = await Promise.all([
        idbGetAll('analysis').catch(() => []),
        idbGetAll('published').catch(() => []),
        idbGetAll('blacklist').catch(() => []),
      ]);
      const st = getState();
      const target = taskTargetUrl(st);
      const pubMap = new Map();
      for (const p of published) {
        if (p && p.url && p.targetUrl === target) {
          pubMap.set(p.url, p);
        }
      }
      const blackSet = new Set(blacklist.map((b) => b.domain));
      const resources = rows
        .filter((r) => r && r.url && VALID_STATUSES.includes(r.status))
        .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)) // 新命中的在前
        .map((r) => {
          const host = domainOf(r.url);
          const isBlacklisted = blackSet.has(host);
          const pub = pubMap.get(r.url);
          return {
            url: r.url,
            domain: host,
            targetDomain: r.targetDomain,
            type: 'blog_comment',
            status: r.status,
            enabled: !isBlacklisted && r.enabled !== false, // 黑名单强制停用
            published: !!pub, // 对当前任务目标地址发布过才算已发布
            verifyStage: pub?.verifyStage || '',
            rel: pub?.rel || '',
            isBlacklisted,
            checkedAt: r.checkedAt,
          };
        });
      return { ok: true, resources };
    }

    // 资源启用/停用：只改 analysis 记录的 enabled 标记，数据保留（删了下次分析会重跑一遍）
    // keys: [[targetDomain, url], ...]，单条与批量（总开关）共用
    case 'setLibraryEnabled': {
      const keys = Array.isArray(msg.keys) ? msg.keys : [];
      const enabled = msg.enabled !== false;
      const want = new Set(keys.map(([d, u]) => `${d} ${u}`));
      addLog('system', `资源启停请求：${keys.length} 条，enabled=${enabled}`, 'info', keys[0] && keys[0][1]);
      const rows = await idbGetAll('analysis').catch(() => []);
      const dirty = rows
        .filter((r) => r && r.url && want.has(`${r.targetDomain} ${r.url}`) && (r.enabled !== false) !== enabled)
        .map((r) => ({ ...r, enabled }));
      // 一条都没匹配到通常是 key 对不上（主键不一致），打印请求 key 与库存样本对比
      if (!dirty.length && keys.length) {
        const sample = rows.filter((r) => r && r.url).slice(0, 3)
          .map((r) => `[${r.targetDomain}, ${r.url}]`).join(' | ');
        addLog('system', `资源启停未匹配到待更新记录：请求 key=${[...want].join(' | ')}；analysis 共 ${rows.length} 条，样本：${sample || '(空)'}`,
          'warn', keys[0] && keys[0][1]);
      }
      if (dirty.length) {
        await idbPutAll('analysis', dirty).catch((e) =>
          addLog('system', `资源启用状态写入失败：${e.message}`, 'warn'));
        // 回读第一条校验落库结果
        const [d, u] = keys[0] || [];
        const back = d ? await idbGet('analysis', [d, u]).catch(() => null) : null;
        addLog('system', `资源启停写入 ${dirty.length} 条；回读校验 enabled=${back ? back.enabled : '(读不到记录)'}`, 'info', u);
      }
      await save('logs');
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    // 资源库行内删除：同时删 analysis 与 backlinks 记录（只删 analysis 的话，该外链会回到「队列中」，下次「开始分析」又重跑回库）；
    // published 发布历史保留
    case 'deleteLibraryResource': {
      const key = [msg.targetDomain || '', msg.url || ''];
      if (!key[1]) return { ok: false, error: '缺少资源 URL' };
      await idbDelete('analysis', key).catch((e) =>
        addLog('system', `删除资源失败（analysis）：${e.message}`, 'warn', key[1]));
      await idbDelete('backlinks', key).catch((e) =>
        addLog('system', `删除资源失败（backlinks）：${e.message}`, 'warn', key[1]));
      addLog('system', `已删除资源：${key[1]}`, 'info', key[1]);
      await save('logs');
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    // ---- 任务模板（存 IndexedDB templates 表，主键 name）：助手页「当前任务」从这里选择填充 ----
    case 'getTemplates': {
      const templates = await idbGetAll('templates').catch(() => []);
      templates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { ok: true, templates };
    }

    case 'saveTemplate': {
      const name = (msg.name || '').trim();
      if (!name) return { ok: false, error: '模板名称不能为空' };
      const tpl = {
        name,
        targetUrl: (msg.targetUrl || '').trim(),
        siteIntro: (msg.siteIntro || '').trim(),
        mainKeyword: (msg.mainKeyword || '').trim(),
        updatedAt: Date.now(),
      };
      await idbPut('templates', tpl);
      addLog('system', `任务模板已保存：${name}`, 'info');
      await save('logs');
      const templates = await idbGetAll('templates').catch(() => []);
      templates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { ok: true, templates };
    }

    case 'deleteTemplate': {
      const name = (msg.name || '').trim();
      if (!name) return { ok: false, error: '模板不存在' };
      await idbDelete('templates', name);
      addLog('system', `任务模板已删除：${name}`, 'info');
      await save('logs');
      const templates = await idbGetAll('templates').catch(() => []);
      templates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { ok: true, templates };
    }

    case 'clearData': {      await collect.stop().catch(() => {});
      await clearAll();
      ensureAlarm(false);
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    case 'clearLogs': {
      getState().logs = [];
      await save('logs');
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    case 'setSettings': {
      // 设置唯一写入口：options 页与 popup 都走这里，避免直接写 storage 被后台内存态覆盖
      const st = getState();
      const patch = msg.patch || {};
      if (patch.language) st.settings.language = patch.language === 'en' ? 'en' : 'zh';
      if (patch.summaryLang) st.settings.summaryLang = patch.summaryLang === 'en' ? 'en' : 'zh';
      if (typeof patch.logEnabled === 'boolean') st.settings.logEnabled = patch.logEnabled;
      if (typeof patch.openrouterKey === 'string') st.settings.openrouterKey = patch.openrouterKey.trim();
      if (patch.models && typeof patch.models === 'object') {
        for (const k of Object.keys(st.settings.models)) {
          if (typeof patch.models[k] === 'string') st.settings.models[k] = patch.models[k].trim();
        }
      }
      if (patch.identity && typeof patch.identity === 'object') {
        if (typeof patch.identity.name === 'string') st.settings.identity.name = patch.identity.name;
        if (typeof patch.identity.email === 'string') st.settings.identity.email = patch.identity.email.trim();
        if (typeof patch.identity.website === 'string') st.settings.identity.website = patch.identity.website.trim();
      }
      // 收集翻页随机间隔（毫秒），收敛到 1s-60s 且 min<=max
      const clamp = (v, d) => Math.min(Math.max(Number(v) || d, 1000), 60000);
      if (patch.pageDelayMinMs != null || patch.pageDelayMaxMs != null) {
        let min = clamp(patch.pageDelayMinMs ?? st.settings.pageDelayMinMs, 3000);
        let max = clamp(patch.pageDelayMaxMs ?? st.settings.pageDelayMaxMs, 9000);
        if (min > max) [min, max] = [max, min];
        st.settings.pageDelayMinMs = min;
        st.settings.pageDelayMaxMs = max;
      }
      // 收集筛选：页面 AS 下限，收敛到 0-100
      if (patch.minAscore != null) {
        st.settings.minAscore = Math.round(Math.min(Math.max(Number(patch.minAscore) || 0, 0), 100));
      }
      // AI 单次请求超时（毫秒），收敛到 5s-300s
      if (patch.aiTimeoutMs != null) {
        st.settings.aiTimeoutMs = Math.min(Math.max(Number(patch.aiTimeoutMs) || 20000, 5000), 300000);
      }
      // 频控与安全约束（补充20261020规范）
      if (patch.dailyPerDomain != null) st.settings.dailyPerDomain = Math.max(1, Math.round(Number(patch.dailyPerDomain) || 1));
      if (patch.weeklyPerDomain != null) st.settings.weeklyPerDomain = Math.max(1, Math.round(Number(patch.weeklyPerDomain) || 2));
      if (patch.minHoursBetweenDomains != null) st.settings.minHoursBetweenDomains = Math.max(0, Number(patch.minHoursBetweenDomains) || 0.5);
      if (patch.skipOnCaptcha != null) st.settings.skipOnCaptcha = !!patch.skipOnCaptcha;
      if (patch.requireIndexed != null) st.settings.requireIndexed = !!patch.requireIndexed;
      if (patch.autoSpamClean != null) st.settings.autoSpamClean = !!patch.autoSpamClean;
      if (patch.spamCleanIntervalHours != null) st.settings.spamCleanIntervalHours = Math.max(1, Math.round(Number(patch.spamCleanIntervalHours) || 24));
      await save('settings');
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    case 'testKey':
      return await testKey(msg.key || '');

    // ---- 滚雪球种子站长（从评论区挖掘的同行域名，存 seeds 表）----
    case 'seeds:get': {
      const seeds = await idbGetAll('seeds').catch(() => []);
      seeds.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      return { ok: true, seeds };
    }

    case 'seeds:pickNext': {
      const seeds = await idbGetAll('seeds').catch(() => []);
      const next = seeds.find((s) => s && s.status !== 'used');
      if (!next) return { ok: false, error: '暂无未收集的种子域名' };
      return { ok: true, seed: next };
    }

    case 'seeds:markUsed': {
      const domain = msg.domain;
      if (!domain) return { ok: false, error: '缺少域名' };
      const item = await idbGet('seeds', domain);
      if (item) {
        await idbPut('seeds', { ...item, status: 'used', usedAt: Date.now() });
        broadcast();
      }
      return { ok: true };
    }

    // ---- 黑名单管理（spam/dead 域名，存 blacklist 表）----
    case 'blacklist:get': {
      const list = await idbGetAll('blacklist').catch(() => []);
      list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      return { ok: true, list };
    }

    case 'blacklist:import': {
      const rawDomains = Array.isArray(msg.domains) ? msg.domains : String(msg.domains || '').split(/[\n,;\s]+/);
      const domains = rawDomains
        .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0])
        .filter((d) => d && d.includes('.'));
      if (!domains.length) return { ok: false, error: '未提供有效域名' };
      const reason = msg.reason || '人工回填/导入黑名单';
      const now = Date.now();
      for (const d of domains) {
        await idbPut('blacklist', { domain: d, reason, source: 'manual_import', addedAt: now });
      }
      // 同步停用资源库中对应域名的资源（按用户 A3 确认）
      const allAnalysis = await idbGetAll('analysis').catch(() => []);
      let disabledCount = 0;
      for (const a of allAnalysis) {
        if (!a || !a.url) continue;
        const host = domainOf(a.url);
        if (domains.includes(host) && a.enabled !== false) {
          a.enabled = false;
          a.reason = `已自动停用（命中黑名单：${host}）`;
          await idbPut('analysis', a);
          disabledCount++;
        }
      }
      addLog('system', `已导入 ${domains.length} 个黑名单域名，同步停用库中 ${disabledCount} 条资源`, 'warn');
      broadcast();
      return { ok: true, imported: domains.length, disabledCount };
    }

    case 'blacklist:remove': {
      const domain = msg.domain;
      if (!domain) return { ok: false, error: '缺少域名' };
      await idbDelete('blacklist', domain);
      addLog('system', `已将 ${domain} 移出黑名单`, 'info');
      broadcast();
      return { ok: true };
    }

    case 'blacklist:clear': {
      await idbClear('blacklist');
      addLog('system', '已清空黑名单', 'info');
      broadcast();
      return { ok: true };
    }

    // ---- 外链 Spam 批量清洗（对接 seo.web.cafe/spam/）----
    case 'spam:checkDirect': {
      let domains = msg.domains;
      if (!domains || !domains.length) {
        const analysis = await idbGetAll('analysis').catch(() => []);
        domains = [...new Set(analysis.filter((a) => a && a.url).map((a) => domainOf(a.url)).filter(Boolean))];
      }
      if (!domains.length) return { ok: false, error: '资源库中暂无待查域名' };
      addLog('system', `开始批量查询外链 Spam：共 ${domains.length} 个域名`, 'info');
      const res = await checkSpamDomainsDirectly(domains);
      if (!res.ok) {
        addLog('system', `直接调用 Spam 接口失败（${res.error}），可点击「打开页面自动查询」`, 'warn');
        return res;
      }
      const spamDomains = res.spamDomains || [];
      let disabledCount = 0;
      if (spamDomains.length) {
        for (const d of spamDomains) {
          await idbPut('blacklist', {
            domain: d,
            reason: 'Ahrefs 判定为垃圾外链域名 (Is spam)',
            source: 'spam_tool',
            addedAt: Date.now(),
          });
        }
        const allAnalysis = await idbGetAll('analysis').catch(() => []);
        for (const a of allAnalysis) {
          if (!a || !a.url) continue;
          const host = domainOf(a.url);
          if (spamDomains.includes(host) && a.enabled !== false) {
            a.enabled = false;
            a.reason = '已自动停用（Ahrefs 判定为垃圾外链域名）';
            await idbPut('analysis', a);
            disabledCount++;
          }
        }
      }
      addLog('system', `外链 Spam 查询完成：共 ${domains.length} 个，发现垃圾域名 ${spamDomains.length} 个${disabledCount ? `，已自动停用 ${disabledCount} 条资源` : ''}`, spamDomains.length ? 'warn' : 'success');
      broadcast();
      return {
        ok: true,
        total: domains.length,
        spamCount: spamDomains.length,
        cleanCount: (res.cleanDomains || []).length,
        unknownCount: (res.unknownDomains || []).length,
        disabledCount,
        spamDomains,
      };
    }

    case 'spam:openPage': {
      let domains = msg.domains;
      if (!domains || !domains.length) {
        const analysis = await idbGetAll('analysis').catch(() => []);
        domains = [...new Set(analysis.filter((a) => a && a.url).map((a) => domainOf(a.url)).filter(Boolean))];
      }
      if (!domains.length) return { ok: false, error: '资源库中暂无待查域名' };
      addLog('system', `正在打开外链 Spam 查询工具页并自动填入 ${domains.length} 个域名...`, 'info');
      return await openSpamPageWithDomains(domains);
    }

    case 'spam:runPeriodic':
      return await runPeriodicSpamClean(true);

    // ---- 内容脚本上报 ----
    // 收集数据集导出（侧边栏下载 CSV）：以 IndexedDB 按目标域名读取，跨收集轮次累积
    case 'getBacklinksCsv': {
      const st = getState();
      const rows = await idbGetDomain('backlinks', st.collectState.targetDomain).catch(() => []);
      if (!rows.length) return { ok: false, error: '还没有收集到外链数据' };
      return { ok: true, csv: backlinksCsv(rows), count: rows.length };
    }

    case 'pub:decision': {
      // 助手页 Submit / Skip：操作对象 = 当前激活标签页（须与 publishRuntime 绑定页面一致）；
      // domain = 面板「定位同行网站」输入框的同行域名，Submit 成功时随 published 记录落库
      const res = await publish.onDecision(msg.decision, msg.domain);
      ensureAlarm(true);
      return res;
    }

    case 'pub:markInvalid': {
      // 助手页「标记为无效资源」：analysis 表该 url 的记录 enabled=false（数据保留）
      return await publish.markInvalid();
    }

    case 'pub:markPublished': {
      // 助手页「标注为已发过」：往 published 表补一条记录（主键 [url, 当前任务目标地址]）；
      // domain = 面板「定位同行网站」输入框的同行域名（空则回落会话 refDomain）
      const res = await publish.markAsPublished(msg.domain);
      ensureAlarm(true);
      return res;
    }

    case 'pub:addResource': {
      // 助手页「将当前资源添加到资源库」：当前标签页补录进 analysis 表（ready）；
      // domain = 面板「定位同行网站」输入框的同行域名（随消息带上，必填）
      return await publish.addCurrentResource(msg.domain);
    }

    case 'pub:note': {
      // 助手页「备注」：给上一次 Submit 成功的发布（lastPublish）打标记，不要求当前标签页绑定
      return await publish.saveNote(msg.comment);
    }

    case 'pub:step': {
      // 助手页的步骤按钮：获取标题与摘要 / 识别表单 / 生成评论 / 填写表单（对当前激活标签页）
      return await publish.onStep(msg.step);
    }

    case 'pub:navigate': {
      // 资源库「立即发布」：当前激活标签页导航到该资源（同行域名随消息带上，bind 时优先使用）
      return await publish.navigateTo(msg.url, msg.refDomain);
    }

    case 'pickNextResource': {
      // 助手页「换一个」：当前激活标签页导航到资源库中未发布过的下一条资源
      return await publish.pickNext();
    }

    default:
      return { ok: false, error: `未知消息类型: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((r) => { try { sendResponse(r || { ok: true }); } catch { /* port closed */ } })
    .catch((e) => { try { sendResponse({ ok: false, error: e.message }); } catch { /* port closed */ } });
  return true; // 异步响应
});

// ---- 保活 / 断点续跑（收集队列；发布由助手页对当前标签页驱动，无后台循环）----
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_SPAM_CLEAN) {
    (async () => {
      await load();
      await runPeriodicSpamClean(false);
    })().catch((e) => console.error('[BCM] spam clean alarm error', e));
    return;
  }
  if (alarm.name !== ALARM_TICK) return;
  (async () => {
    await load();
    ensureControllers();
    const st = getState();
    if (st.collectState.status === 'running') collect.resume();
    // SW 在停止途中被回收时状态会卡在 stopping：此处无循环在跑（新实例），直接落地为 idle
    if (st.collectState.status === 'stopping' && !collect.busy && !collect.scraping) {
      collect.finish('stopCollect');
    }
    // T+10 分钟回访验证
    await runVerifyDue(Date.now()).catch((e) => console.error('[BCM] verify error', e));
    if (await isIdle()) ensureAlarm(false);
  })().catch((e) => console.error('[BCM] alarm error', e));
});

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    await load();
    ensureControllers();
    await refreshCollectStatsFromIdb();
    chrome.alarms.create(ALARM_SPAM_CLEAN, { periodInMinutes: 60 });
    const st = getState();
    // 断点续跑：安装/更新时如果状态是 running，恢复队列处理
    if (st.collectState.status === 'running') collect.resume();
  })().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await load();
    ensureControllers();
    await refreshCollectStatsFromIdb();
    chrome.alarms.create(ALARM_SPAM_CLEAN, { periodInMinutes: 60 });
    const st = getState();
    if (st.collectState.status === 'running') collect.resume();
  })().catch(console.error);
});

// 标签页被用户手动关闭时清理引用
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await load();
    const st = getState();
    if (st.collectState.providerTabId === tabId) st.collectState.providerTabId = null;
    if (st.collectState.analyzeTabId === tabId) st.collectState.analyzeTabId = null;
    if (st.publishRuntime && st.publishRuntime.tabId === tabId) st.publishRuntime.tabId = null;
  })().catch(() => {});
});

// 列表页整页跳转后（SPA 内部跳转不会触发）重新注入拦截钩子
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  (async () => {
    await load();
    ensureControllers();
    const st = getState();
    if (st.collectState.status === 'running' && st.collectState.providerTabId === tabId) {
      collect.injectInterceptor().catch((e) => addLog('collect', `重新注入拦截器失败：${e.message}`, 'warn'));
    }
  })().catch(() => {});
});
