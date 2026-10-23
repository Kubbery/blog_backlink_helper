/**
 * 页面分析器：采集候选博客文章页的信息，供分析阶段的规则判定（登录/评论表单/验证码）使用。
 * 由 background 注入后调用 window.__BCM_ANALYZE__(cfg)，同步返回结果对象。
 */
(function () {
  if (window.__BCM_ANALYZE__) return;

  function q(sel) {
    try { return document.querySelector(sel); } catch { return null; }
  }
  function qAny(list) {
    for (const s of list || []) {
      const el = q(s);
      if (el) return el;
    }
    return null;
  }
  function qa(sel) {
    try { return [...document.querySelectorAll(sel)]; } catch { return []; }
  }

  window.__BCM_ANALYZE__ = function analyze(cfg) {
    const selectors = (cfg && cfg.selectors) || {};
    const loginHints = (cfg && cfg.loginHints) || [];
    try {
      const title = (document.querySelector('title')?.textContent || document.title || '').trim();
      const desc = q('meta[name="description"]')?.content || '';
      const bodyClone = document.body ? document.body.cloneNode(true) : null;

      // 正文文本：优先 article，退化为 body 全文（截断交给后台）
      let text = '';
      const article = q('article') || q('main') || q('.entry-content') || q('.post-content');
      if (article) text = article.innerText || '';
      if (!text && bodyClone) {
        bodyClone.querySelectorAll('script,style,noscript,nav,header,footer').forEach((el) => el.remove());
        text = bodyClone.innerText || '';
      }

      const commentForm = qAny(selectors.commentForm);
      const textarea = qAny(selectors.commentTextarea);
      const loginEl = qAny(selectors.loginRequiredText);
      let loginRequired = !!loginEl;
      if (!loginRequired) {
        const hay = ((loginEl && loginEl.innerText) || document.body?.innerText || '').toLowerCase().slice(0, 20000);
        loginRequired = loginHints.some((h) => hay.includes(h.toLowerCase()));
      }

      const hasForm = !!(commentForm || textarea);

      // 提取邮箱（mailto 链接与页面文本正则）
      const emailSet = new Set();
      for (const a of qa('a[href^="mailto:"]')) {
        const m = (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
        if (m && m.includes('@') && !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(m)) {
          emailSet.add(m);
        }
      }
      const rawText = (document.body?.innerText || '').slice(0, 30000);
      const emailMatches = rawText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || [];
      for (const em of emailMatches) {
        const clean = em.trim().toLowerCase();
        if (!/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(clean) &&
            !clean.includes('example.com') && !clean.includes('domain.com') &&
            !clean.includes('sentry') && !clean.startsWith('user@') && !clean.startsWith('test@')) {
          emailSet.add(clean);
        }
      }
      const emails = [...emailSet].slice(0, 5);

      // 联络页面链接
      let contactUrl = '';
      const contactA = qa('a[href]').find((a) => {
        const href = (a.getAttribute('href') || '').toLowerCase();
        const t = (a.textContent || '').trim().toLowerCase();
        return (href.includes('contact') || href.includes('about') || t.includes('contact') || t.includes('联系我们')) &&
               !href.startsWith('mailto:') && !href.startsWith('javascript:');
      });
      if (contactA) {
        try { contactUrl = new URL(contactA.getAttribute('href'), location.href).href; } catch {}
      }

      // 特征探测：客座投稿 / Write For Us
      const loc = location.href.toLowerCase();
      const hText = qa('h1, h2, h3').map((h) => (h.textContent || '').trim()).join(' ').toLowerCase();
      const isGuestPost = /write[-_]for[-_]us|submit[-_](guest[-_])?post|become[-_]a[-_]contributor|guest[-_]article|guest[-_]post|editorial[-_]guidelines|contribute|tougao/i.test(loc) ||
        /write for us|submit a (guest )?post|guest post guidelines|become a contributor|contribute to|投稿指南|文章投递|征稿/i.test(title.toLowerCase() + ' ' + hText) ||
        !!q('form input[name*="pitch" i], form input[name*="bio" i], form textarea[name*="pitch" i], form textarea[name*="bio" i]');

      // 特征探测：目录 / 导航站收录提交
      const isDirectory = /submit[-_](site|url|tool|listing|startup|product|link)|add[-_](site|url|tool|listing|startup|link)|directory|listing/i.test(loc) ||
        /submit (your )?(site|url|tool|listing|startup|product|link)|add (your )?(site|url|tool|listing|startup|link)|提交网站|提交收录|收录申请|网站提交/i.test(title.toLowerCase() + ' ' + hText) ||
        !!(q('form input[type="url"], form input[name*="url" i], form input[name*="website" i], form input[name*="domain" i]') &&
           q('form input[name*="title" i], form input[name*="name" i], form input[name*="site" i]'));

      // 特征探测：资源推荐页
      const isResourcePage = /resources|resource[-_]list|useful[-_]links|tools[-_]and[-_]resources|useful[-_]resources|recommended[-_]tools/i.test(loc) ||
        /useful resources|recommended tools|resource list|useful links|行业资源推荐/i.test(title.toLowerCase() + ' ' + hText);

      // 特征探测：论坛社区
      const isForum = /forum|community|discussions|\/t\/|\/topic\/|\/thread\//i.test(loc) ||
        !!q('meta[name="generator"][content*="Discourse" i], meta[name="generator"][content*="phpBB" i], meta[name="generator"][content*="XenForo" i], #phpbb, .discourse-root, .forum-content, #xenforo');

      // 评论区 HTML（用于提取评论者网站，滚雪球种子）
      const commentList = qAny(selectors.commentList);
      const commentHtml = commentList ? commentList.innerHTML.slice(0, 60000) : '';

      return {
        ok: true,
        url: location.href,
        title,
        description: desc,
        text: (text || '').replace(/\s+/g, ' ').slice(0, 12000),
        hasForm,
        loginRequired,
        hasCaptcha: !!qAny(selectors.captcha),
        commentHtml,
        emails,
        contactUrl,
        signals: {
          isComment: hasForm && !isGuestPost && !isDirectory,
          isGuestPost: !!isGuestPost,
          isDirectory: !!isDirectory,
          isResourcePage: !!isResourcePage,
          isForum: !!isForum,
        },
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
})();
