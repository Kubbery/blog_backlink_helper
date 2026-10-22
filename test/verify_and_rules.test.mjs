/**
 * 补充20261020规范单测：
 * 1. 评论区外链挖掘提取（extractCommenterDomains）
 * 2. 失效域名黑名单与资源联动停用（handleDeadDomain）
 * 3. 换一个（pickNext）横向优先、频控与黑名单过滤
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installIdbStub } from './stubs.mjs';

installIdbStub();

const storeData = {};
let activeTabUrl = 'https://active-tab.com/post';
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (k in storeData ? { [k]: storeData[k] } : {}),
      set: async (obj) => { Object.assign(storeData, obj); },
      remove: async (k) => { delete storeData[k]; },
    },
  },
  tabs: {
    query: async () => (activeTabUrl ? [{ id: 1, url: activeTabUrl }] : []),
    update: async (_id, opt) => { activeTabUrl = opt.url; },
  },
  alarms: {
    create: () => {},
  },
};

let extractCommenterDomains, handleDeadDomain, PublishAssistant, idbGet, idbGetAll, idbPut, idbPutAll;

before(async () => {
  ({ extractCommenterDomains } = await import('../extension/lib/util.js'));
  ({ handleDeadDomain } = await import('../extension/background/verify.js'));
  ({ PublishAssistant } = await import('../extension/background/publish.js'));
  ({ idbGet, idbGetAll, idbPut, idbPutAll } = await import('../extension/lib/idb.js'));
});

test('extractCommenterDomains：从评论 HTML 抽取站长域名并过滤社交与本站域名', () => {
  const html = `
    <div class="comment">
      <span class="comment-author"><a href="https://cool-tools.io/app">Cool Guy</a></span>
      <p>Nice post!</p>
    </div>
    <div class="comment">
      <cite class="fn"><a href="http://www.marketing-guru.com/">Guru</a></cite>
      <p>Great stuff.</p>
    </div>
    <div class="comment">
      <span class="url"><a href="https://twitter.com/user">Twitter Link</a></span>
    </div>
    <div class="comment">
      <span class="comment-author"><a href="https://myblog.com/page">Author</a></span>
    </div>
  `;
  const domains = extractCommenterDomains(html, { currentDomain: 'myblog.com' });
  assert.ok(domains.includes('cool-tools.io'));
  assert.ok(domains.includes('marketing-guru.com'));
  assert.ok(!domains.includes('twitter.com'), '应过滤社交媒体');
  assert.ok(!domains.includes('myblog.com'), '应排除当前博客本身域名');
});

test('handleDeadDomain：回访失效域名自动加入黑名单并停用库中同域名资源', async () => {
  const domain = 'dead-site.com';
  await idbPut('analysis', {
    targetDomain: 'peer.com',
    url: 'https://dead-site.com/blog/1',
    status: 'ready',
    enabled: true,
  });
  await idbPut('analysis', {
    targetDomain: 'peer.com',
    url: 'https://dead-site.com/blog/2',
    status: 'ready',
    enabled: true,
  });
  await idbPut('analysis', {
    targetDomain: 'peer.com',
    url: 'https://alive-site.com/blog/1',
    status: 'ready',
    enabled: true,
  });

  await handleDeadDomain(domain, 'https://dead-site.com/blog/1');

  // 1. blacklist 表中有该域名
  const bl = await idbGet('blacklist', domain);
  assert.ok(bl, '黑名单中应包含 dead-site.com');

  // 2. dead-site.com 下的所有资源 enabled 变为 false
  const r1 = await idbGet('analysis', ['peer.com', 'https://dead-site.com/blog/1']);
  const r2 = await idbGet('analysis', ['peer.com', 'https://dead-site.com/blog/2']);
  const alive = await idbGet('analysis', ['peer.com', 'https://alive-site.com/blog/1']);

  assert.equal(r1.enabled, false);
  assert.equal(r2.enabled, false);
  assert.equal(alive.enabled, true, '其它域名资源不受影响');
});

test('pickNext：横向优先（未发布过的域名优先于已发布域名）', async () => {
  const a = new PublishAssistant(async () => {});
  // 清空测试相关的表
  const allAnalysis = await idbGetAll('analysis');
  for (const r of allAnalysis) {
    if (r.url.includes('prio-test')) r.enabled = false;
  }

  // 域名 A：已发布过 1 条
  await idbPut('published', {
    url: 'https://site-a.com/post-old',
    targetUrl: 'https://my-brand.com',
    publishedAt: Date.now() - 3600000 * 48, // 2 天前
  });
  await idbPut('analysis', {
    targetDomain: 'peer.com',
    url: 'https://site-a.com/prio-test-new',
    status: 'ready',
    enabled: true,
    checkedAt: Date.now() + 100, // 时间更近
  });

  // 域名 B：从未发布过 (totalPub === 0)
  await idbPut('analysis', {
    targetDomain: 'peer.com',
    url: 'https://site-b.com/prio-test-brand-new',
    status: 'ready',
    enabled: true,
    checkedAt: Date.now(),
  });

  const picked = await a.pickNext('https://my-brand.com');
  assert.ok(picked);
  assert.equal(picked.url, 'https://site-b.com/prio-test-brand-new', '从未发布过的域名 B 应横向优先');
});

test('pickNext：黑名单域名在换一个时被自动跳过', async () => {
  const a = new PublishAssistant(async () => {});
  await idbPut('blacklist', { domain: 'banned-site.com' });
  await idbPut('analysis', {
    targetDomain: 'peer.com',
    url: 'https://banned-site.com/post-1',
    status: 'ready',
    enabled: true,
  });
  await idbPut('analysis', {
    targetDomain: 'peer.com',
    url: 'https://clean-site.com/post-1',
    status: 'ready',
    enabled: true,
  });

  const picked = await a.pickNext('https://target-test.com');
  assert.ok(picked);
  assert.notEqual(picked.domain, 'banned-site.com', '黑名单站点不得被挑中');
});
