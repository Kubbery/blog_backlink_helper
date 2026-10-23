/**
 * CollectController.statsBaseline 口径测试：与空闲时 refreshCollectStatsFromIdb 同口径——
 * 已发现=backlinks 条数；已分析=analysis 条数；队列中=backlinks 里未分析的；
 * 博客评论资源=analysis 中 ready/captcha 条数（与资源库筛选一致）。
 * 打内存版 indexedDB 最小桩，不启动浏览器。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installIdbStub } from './stubs.mjs';

installIdbStub();
// collect.js 经 storage.js 间接引用 chrome.storage：打最小桩让模块可加载
const storeData = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (k in storeData ? { [k]: storeData[k] } : {}),
      set: async (obj) => { Object.assign(storeData, obj); },
      remove: async (k) => { delete storeData[k]; },
    },
  },
  runtime: { sendMessage: () => Promise.reject(new Error('no receiver')) },
};

let CollectController, idbPutAll, idbGet;

before(async () => {
  ({ CollectController } = await import('../extension/background/collect.js'));
  ({ idbPutAll, idbGet } = await import('../extension/lib/idb.js'));
  const bl = (url) => ({ targetDomain: 'example.com', url, domain: 'b.com' });
  await idbPutAll('backlinks', [
    bl('https://a.com/1'), bl('https://a.com/2'), bl('https://a.com/3'),
    bl('https://a.com/4'), bl('https://a.com/5'),
  ]);
  const an = (url, status) => ({ targetDomain: 'example.com', url, status });
  await idbPutAll('analysis', [
    an('https://a.com/1', 'ready'),
    an('https://a.com/2', 'captcha'),
    an('https://a.com/3', 'invalid'),
  ]);
});

test('statsBaseline：四项统计与 IndexedDB 存量口径一致', async () => {
  const c = new CollectController(async () => {});
  const base = await c.statsBaseline('example.com');
  assert.equal(base.discovered, 5); // backlinks 表该域名条数
  assert.equal(base.analyzed, 3);   // analysis 表条数
  assert.equal(base.queued, 2);     // backlinks 未分析（5 - 3）
  assert.equal(base.matched, 2);    // analysis 中 ready/captcha（与资源库筛选一致）
  assert.equal(base.links.length, 5);
  assert.equal(base.rows.length, 3);
});

test('statsBaseline：无数据域名四项全为 0', async () => {
  const c = new CollectController(async () => {});
  const base = await c.statsBaseline('nope.com');
  assert.deepEqual(
    [base.discovered, base.analyzed, base.queued, base.matched],
    [0, 0, 0, 0],
  );
});

test('onScrapedRows 与 recordAnalysis：外链与分析记录带上服务的目标域名', async () => {
  const c = new CollectController(async () => {});
  c.cs.targetDomain = 'peer-site.com';
  c.cs.myTargetDomain = 'my-target.com';
  c.cs.seen = [];
  c.cs.queue = [];

  const rawRows = [
    { url: 'https://blog.com/article-1', platform: '博客', ascore: '30' },
  ];
  const kept = c.onScrapedRows(rawRows, 1);
  assert.equal(kept, 1);

  const backlink = await idbGet('backlinks', ['peer-site.com', 'https://blog.com/article-1']);
  assert.ok(backlink);
  assert.equal(backlink.myTargetDomain, 'my-target.com');

  await c.recordAnalysis('peer-site.com', 'https://blog.com/article-1', 'ready', '有评论表单');
  const analysis = await idbGet('analysis', ['peer-site.com', 'https://blog.com/article-1']);
  assert.ok(analysis);
  assert.equal(analysis.myTargetDomain, 'my-target.com');
  assert.equal(analysis.status, 'ready');
});

test('onScrapedRows：放宽平台过滤，保留目录、论坛、媒体等各类手动外链平台', async () => {
  const c = new CollectController(async () => {});
  c.cs.targetDomain = 'peer-site.com';
  c.cs.seen = [];

  const rawRows = [
    { url: 'https://dir.com/submit-site', platform: '目录', ascore: '25' },
    { url: 'https://forum.com/thread-1', platform: '论坛', ascore: '40' },
    { url: 'https://media.com/news-1', platform: '新闻', ascore: '35' },
  ];
  const kept = c.onScrapedRows(rawRows, 1);
  assert.equal(kept, 3);

  const dirLink = await idbGet('backlinks', ['peer-site.com', 'https://dir.com/submit-site']);
  assert.ok(dirLink);
  assert.equal(dirLink.platform, '目录');
});

test('recordAnalysis：支持多分类与邮箱存储，且人工修改的分类（manualType）不被覆盖', async () => {
  const c = new CollectController(async () => {});
  c.cs.targetDomain = 'peer-site.com';

  // 1. 初次分析命中 guest_post，提取到邮箱
  await c.recordAnalysis('peer-site.com', 'https://guest.com/write-for-us', 'ready', '命中客座投稿', {
    type: 'guest_post',
    emails: ['editor@guest.com'],
    contactEmail: 'editor@guest.com',
  });
  let record = await idbGet('analysis', ['peer-site.com', 'https://guest.com/write-for-us']);
  assert.equal(record.type, 'guest_post');
  assert.equal(record.contactEmail, 'editor@guest.com');

  // 2. 模拟用户手动修改分类为 outreach_contact
  record.type = 'outreach_contact';
  record.manualType = true;
  await (await import('../extension/lib/idb.js')).idbPut('analysis', record);

  // 3. 再次分析该页面时，应保护用户的 manualType 不被重置
  await c.recordAnalysis('peer-site.com', 'https://guest.com/write-for-us', 'ready', '重新分析命中', {
    type: 'guest_post',
  });
  const updated = await idbGet('analysis', ['peer-site.com', 'https://guest.com/write-for-us']);
  assert.equal(updated.type, 'outreach_contact'); // 仍然保留用户修改的分类
});
