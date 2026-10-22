/**
 * 通用工具函数。
 */

export function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地日期时间字符串（如 2026-09-18 14:03:22），默认取当前时间 */
export function fmtDateTime(ts = Date.now()) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 等待某个 tab 完成 loaded 状态，超时返回 false */
export function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(false); } }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete' && !done) {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && !done) {
        // 已加载完成的标签（例如复用的旧 tab 导航前状态），仍等一次事件；
        // 若 800ms 内无事件则直接放行
        setTimeout(() => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(true);
          }
        }, 800);
      }
    }).catch(() => {
      if (!done) { done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(false); }
    });
  });
}

/** 从任意 JSON 结构里递归抽出 http(s) 绝对 URL（外链拦截的通用兜底） */
export function extractUrlsDeep(obj, { excludeHosts = [], excludeDomains = [] } = {}) {
  const found = new Set();
  const exclude = [...excludeHosts, ...excludeDomains];
  const visit = (v, depth) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      const m = v.match(/^https?:\/\/[^\s"'<>\\]+$/i);
      if (m) {
        try {
          const u = new URL(v);
          const host = u.hostname.toLowerCase();
          if (!exclude.some((h) => hostMatches(host, h))) found.add(u.origin + u.pathname + u.search);
        } catch { /* ignore */ }
      }
      return;
    }
    if (Array.isArray(v)) { for (const it of v) visit(it, depth + 1); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) visit(v[k], depth + 1); }
  };
  visit(obj, 0);
  return [...found];
}

/** 从 HTML 里提取评论者留下的网站链接（滚雪球种子） */
export function extractCommenterSites(html, pageHost = '') {
  const out = new Set();
  try {
    const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
      try {
        const u = new URL(m[1]);
        if (u.hostname !== pageHost && !/wp\.login|wordpress|feed|\.xml$/i.test(u.hostname + u.pathname)) {
          out.add(u.hostname.replace(/^www\./, ''));
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return [...out].slice(0, 50);
}

const DEFAULT_IGNORED_DOMAINS = new Set([
  'wordpress.org', 'wordpress.com', 'w.org', 'gravatar.com', 'automattic.com',
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'linkedin.com', 'github.com', 'pinterest.com', 'reddit.com', 't.me',
  'telegram.org', 'tiktok.com', 'google.com', 'apple.com', 'microsoft.com',
  'schema.org', 'w3.org', 'cloudflare.com', 'mozilla.org',
]);

/** 从评论区 HTML 提取评论者留下的外链域名——这些就是同行站长，全是已验证可发的资源 */
export function extractCommenterDomains(commentHtml, { selfHost = '', currentDomain = '', excludeHosts = [] } = {}) {
  const out = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["']/gi;
  let m;
  const normSelf = (selfHost || currentDomain || '').toLowerCase().replace(/^www\./, '');
  const customExcludes = new Set((excludeHosts || []).map((e) => (e || '').toLowerCase().replace(/^www\./, '')));
  while ((m = re.exec(String(commentHtml || '')))) {
    try {
      const raw = m[1];
      const h = new URL(raw, 'https://x.invalid').hostname.replace(/^www\./, '').toLowerCase();
      if (!h || h === 'x.invalid') continue;
      if (normSelf && (h === normSelf || h.endsWith('.' + normSelf))) continue;
      if (DEFAULT_IGNORED_DOMAINS.has(h) || [...DEFAULT_IGNORED_DOMAINS].some((d) => h.endsWith('.' + d))) continue;
      if (customExcludes.has(h) || [...customExcludes].some((e) => e && (h === e || h.endsWith('.' + e)))) continue;
      if (/\/(wp-|feed|comments|category|tag|author)\//i.test(raw)) continue;
      out.add(h);
    } catch { /* 相对链接，跳过 */ }
  }
  return [...out];
}

/** 资源列表 → CSV（带 BOM，Excel 友好） */
export function toCSV(resources) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['url', 'domain', 'type', 'status', 'addedAt', 'publishedAt'];
  const lines = [head.join(',')];
  for (const r of resources) {
    lines.push([r.url, r.domain, r.type, r.status, fmtDate(r.addedAt), fmtDate(r.publishedAt)].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/** 收集数据集（Semrush 博客外链行）→ CSV（带 BOM，Excel 友好） */
export function backlinksCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['url', 'domain', 'title', 'platform', 'ascore', 'anchor', 'targetUrl', 'extLinks', 'intLinks', 'firstSeen', 'lastSeen', 'page', 'addedAt'];
  const lines = [head.join(',')];
  for (const r of rows || []) {
    lines.push([
      esc(r.url), esc(r.domain), esc(r.title), esc(r.platform),
      esc(r.ascore), esc(r.anchor), esc(r.targetUrl), esc(r.extLinks), esc(r.intLinks),
      esc(r.firstSeen), esc(r.lastSeen),
      r.page ?? '', esc(fmtDate(r.addedAt)),
    ].join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/** 上层域匹配：host 是否属于 domain（含子域） */
export function hostMatches(host, domain) {
  if (!host || !domain) return false;
  host = host.toLowerCase().replace(/^www\./, '');
  domain = domain.toLowerCase().replace(/^www\./, '');
  return host === domain || host.endsWith('.' + domain);
}

/** 两个 URL 是否同一页面：忽略大小写、协议、host 前导 www.、hash 与末尾斜杠（按 URL 查来源时容忍跳转差异） */
export function samePageUrl(a, b) {
  const norm = (u) => String(u || '').toLowerCase().split('#')[0]
    .replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
  const x = norm(a);
  return !!x && x === norm(b);
}

/** 从 HTML 中解码常见 HTML 实体 */
export function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 从 HTML 字符串解析网站元数据（标题、描述、关键词、站点名称、核心文本） */
export function parseSiteMetadata(html, url = '') {
  if (!html) return { url, title: '', siteName: '', description: '', keywords: '', text: '' };

  const s = String(html);

  // 1. Title
  let title = '';
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();

  // 2. Meta tags
  let siteName = '';
  let description = '';
  let keywords = '';

  const metaRegex = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRegex.exec(s))) {
    const tag = m[0];
    const nameMatch = tag.match(/(?:name|property)=["']([^"']+)["']/i);
    const contentMatch = tag.match(/content=["']([^"']*)["']/i);
    if (!nameMatch || !contentMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const content = decodeHtmlEntities(contentMatch[1]).trim();
    if (!content) continue;

    if (!siteName && (name === 'og:site_name' || name === 'application-name')) {
      siteName = content;
    }
    if (!description && (name === 'description' || name === 'og:description' || name === 'twitter:description')) {
      description = content;
    }
    if (!keywords && (name === 'keywords' || name === 'news_keywords')) {
      keywords = content;
    }
  }

  // 3. Main text: 移除 script, style, svg, noscript 等标签
  let text = s
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text).replace(/\s+/g, ' ').trim().slice(0, 3000);

  return { url, title, siteName, description, keywords, text };
}

/** 规则提取网站信息（当没有 AI 或 AI 失败时的纯程序降级逻辑） */
export function ruleExtractSiteInfo({ url = '', title = '', siteName = '', description = '', keywords = '', text = '' } = {}) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    hostname = url.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./, '');
  }
  const hostBrand = hostname ? (hostname.split('.')[0] || '').replace(/[-_]/g, ' ') : '';
  const capitalizedHostBrand = hostBrand ? hostBrand.charAt(0).toUpperCase() + hostBrand.slice(1) : '';

  // 1. name: siteName || title 分割取干净名称 || 域名大写
  let name = siteName;
  if (!name && title) {
    const parts = title.split(/[|\-–_•—:：]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      // 优先找匹配域名的部分，或者取较短的部分作为品牌名
      const matchPart = parts.find((p) => hostBrand && p.toLowerCase().includes(hostBrand.toLowerCase()));
      if (matchPart && matchPart.length <= 30) {
        name = matchPart;
      } else {
        // 取最短且非空的片段（通常是品牌名，长片段通常是包含大量 SEO 词的副标题）
        const sorted = [...parts].sort((a, b) => a.length - b.length);
        name = sorted[0];
      }
    } else {
      name = parts[0] || '';
    }
  }
  if (!name || name.length > 40) name = capitalizedHostBrand || (name ? name.slice(0, 30) : '');

  // 2. siteIntro: description || text 前 150 字
  let intro = description || text.slice(0, 150);
  if (intro.length > 200) intro = intro.slice(0, 200) + '…';

  // 3. mainKeyword: keywords 第一项 || 从 title 提取
  let keyword = '';
  if (keywords) {
    keyword = keywords.split(/[,，;|]/)[0].trim();
  }
  if (!keyword && title) {
    const cleanTitle = title.replace(name, '').replace(/[|\-–_•—:：]/g, ' ').trim();
    if (cleanTitle) {
      const words = cleanTitle.split(/\s+/).filter(Boolean);
      keyword = words.slice(0, 3).join(' ');
    }
  }
  if (!keyword) keyword = name;

  return {
    name: name.slice(0, 40).trim(),
    targetUrl: url,
    siteIntro: intro.trim(),
    mainKeyword: keyword.slice(0, 50).trim(),
  };
}
