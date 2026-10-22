/**
 * 发布回访：T+10 分钟重开页面，检查自己的评论是否渲染、链接 rel 是什么。
 * 由 service-worker 的定时 tick（30 秒）驱动，只处理 verifyAt <= now 且未完成的任务。
 *
 * 回访结果状态机：
 *   渲染出来了 + rel 为空         → done（dofollow，真正有效的外链）
 *   渲染出来了 + rel 含 nofollow  → done（不传权重，单列一类）
 *   没渲染 + 页面有审核提示       → moderation（T+24h 再查一次）
 *   没渲染 + 无审核提示           → dead（域名进黑名单）
 *   执行异常                      → retry（下次 tick 重试）
 */
import { idbGetAll, idbPut } from '../lib/idb.js';
import { addLog } from '../lib/storage.js';
import { ANALYZE_SELECTORS } from '../lib/config.js';

/** 注入到目标页执行：找自己的评论并读 rel */
function scanOwnComment(cfg) {
  try {
    const scope = (cfg.commentList || [])
      .map((s) => { try { return document.querySelector(s); } catch { return null; } })
      .find(Boolean) || document;
    const hit = [...scope.querySelectorAll('a[href]')]
      .find((a) => cfg.domain && (a.href || '').toLowerCase().includes(cfg.domain));
    if (!hit) {
      const pageText = (document.body?.innerText || '').toLowerCase();
      return {
        ok: true,
        found: false,
        moderation: /awaiting moderation|等待审核|待审核|your comment is awaiting/.test(pageText),
      };
    }
    const box = hit.closest('li, .comment, .comment-body, article, p') || hit;
    return {
      ok: true,
      found: true,
      rel: (hit.getAttribute('rel') || '').toLowerCase(),
      anchorText: (hit.textContent || '').trim().slice(0, 60),
      snippet: (box.textContent || '').replace(/\s+/g, ' ').slice(0, 160),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 等待标签页加载完成（带超时） */
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(false); }, timeoutMs);
    function onUpd(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

/**
 * 执行到期的回访任务：从 published 表取 verifyAt <= now 且 verifyStage 不是 done 的记录，
 * 逐条打开页面 → 注入扫描脚本 → 更新结果。每条之间随机等 5-10 秒，避免频率过快。
 */
export async function runVerifyDue(now) {
  if (typeof chrome === 'undefined' || !chrome.tabs?.create || !chrome.scripting?.executeScript) return;
  const rows = await idbGetAll('published').catch(() => []);
  const due = rows.filter((r) => r.verifyAt && r.verifyAt <= now && r.verifyStage !== 'done' && r.verifyStage !== 'dead');
  if (!due.length) return;
  addLog('verify', `回访队列：${due.length} 条到期`, 'info');
  for (const r of due) {
    addLog('verify', `回访 ${r.url}`, 'info', r.url);
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: r.url, active: false });
      const loaded = await waitTabComplete(tab.id, 30000);
      if (!loaded) {
        addLog('verify', '页面加载超时，标记为 retry', 'warn', r.url);
        await idbPut('published', { ...r, verifyStage: 'retry' });
        await chrome.tabs.remove(tab.id).catch(() => {});
        continue;
      }
      // 等待页面渲染稳定
      await new Promise((s) => setTimeout(s, 2000));
      const targetDomain = (() => {
        try { return new URL(r.targetUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
      })();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: scanOwnComment,
        args: [{ domain: targetDomain, commentList: ANALYZE_SELECTORS.commentList }],
      });
      await chrome.tabs.remove(tab.id).catch(() => {});
      tab = null;
      // 合并多框架结果：任意框架找到即算找到
      const res = (results || []).map((r) => r && r.result).find((r) => r && r.found) || (results && results[0] && results[0].result) || {};

      // 状态机：渲染出来 → done；没渲染但有审核提示 → moderation（等 24h）；否则 → dead
      const stage = res.found ? 'done' : (res.moderation ? 'moderation' : 'dead');
      await idbPut('published', {
        ...r,
        verifyStage: stage,
        verifiedAt: Date.now(),
        visible: !!res.found,
        rel: res.rel || '',
        anchorText: res.anchorText || '',
        snippet: res.snippet || '',
        // 待审核的 T+24h 复查；其余保留原值不再改
        verifyAt: stage === 'moderation' ? now + 24 * 3600 * 1000 : r.verifyAt,
      });
      if (res.found) {
        const relInfo = res.rel ? `rel="${res.rel}"（不传权重）` : 'dofollow（有效外链）';
        addLog('verify', `✓ 评论已渲染：${relInfo}，锚文本="${res.anchorText || '(无)'}"`, 'success', r.url);
      } else if (res.moderation) {
        addLog('verify', '评论待审核（页面有审核提示），T+24h 复查', 'warn', r.url);
      } else {
        // 判 dead：自动将博客域名加入黑名单，并自动停用资源库中该域名的其余资源（按纪律执行）
        const blogDomain = (() => {
          try { return new URL(r.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
        })();
        const disabledCount = await handleDeadDomain(blogDomain, r.url);
        addLog('verify', `✗ 评论未渲染、无审核提示 → 判 dead，域名「${blogDomain}」已入黑名单${disabledCount ? `（同步停用库中 ${disabledCount} 条资源）` : ''}`, 'warn', r.url);
      }
    } catch (e) {
      if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
      await idbPut('published', { ...r, verifyStage: 'retry' });
      addLog('verify', `回访失败：${e.message}`, 'warn', r.url);
    }
    // 每条之间随机等 5-10 秒
    await new Promise((s) => setTimeout(s, 5000 + Math.random() * 5000));
  }
}

/**
 * 处理 dead 域名：写入 blacklist 并同步停用 analysis 库中同域名所有资源
 * 导出以便单测验证状态机与联动逻辑
 */
export async function handleDeadDomain(domain, fromUrl = '') {
  if (!domain) return 0;
  await idbPut('blacklist', {
    domain,
    reason: '回访未渲染且无审核提示（已死/删评）',
    source: 'verify_dead',
    fromUrl,
    addedAt: Date.now(),
  }).catch(() => {});

  const allAnalysis = await idbGetAll('analysis').catch(() => []);
  let disabledCount = 0;
  for (const item of allAnalysis) {
    if (!item || !item.url) continue;
    const itemDomain = (() => {
      try { return new URL(item.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
    })();
    if (itemDomain === domain && item.enabled !== false) {
      item.enabled = false;
      item.reason = `已自动停用（同域名回访未渲染判 dead：${domain}）`;
      await idbPut('analysis', item).catch(() => {});
      disabledCount++;
    }
  }
  return disabledCount;
}
