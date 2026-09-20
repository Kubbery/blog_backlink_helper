/**
 * PublishAssistant 纯逻辑测试：Submit 成功后的落库行为 + 助手页手动补录。
 * 口径：markPublished 写 published 表（含 targetDomain 同行域名）；ensureAnalysisResource
 * 把不在资源库（analysis 表）的页面补录为 ready 资源（按同行域名归档），同 url 已有记录
 * （任意同行域名）或缺少同行域名时跳过；addCurrentResource（「将当前资源添加到资源库」按钮）
 * 同口径补录当前激活标签页，同行域名必填（取「定位同行网站」输入框），已在资源库则拒绝；
 * markAsPublished（「标注为已发过」按钮）直接往 published 表补记录，目标地址取当前任务
 * （缺省回落设置里的身份网址），同主键已有记录或目标地址为空时拒绝。
 * 打内存版 IndexedDB / chrome.storage / chrome.tabs 最小桩。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installIdbStub } from './stubs.mjs';

installIdbStub();

// ---------- 内存版 chrome.storage 最小桩（addLog/save 不落到真实存储） ----------
const storeData = {};
// addCurrentResource 取当前激活标签页：用可变桩模拟（默认一个可注入网页）
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
  },
};

let PublishAssistant, idbGet, idbGetAll, idbPutAll, getState;

before(async () => {
  ({ PublishAssistant } = await import('../extension/background/publish.js'));
  ({ idbGet, idbGetAll, idbPutAll } = await import('../extension/lib/idb.js'));
  ({ getState } = await import('../extension/lib/storage.js'));
});

const assistant = () => new PublishAssistant(async () => {});

test('markPublished：写入 published 记录（含 targetDomain 同行域名）', async () => {
  const a = assistant();
  await a.markPublished('https://blog.com/p1', 'https://me.com', '任务A', 'peer.com');
  const row = await idbGet('published', ['https://blog.com/p1', 'https://me.com']);
  assert.equal(row.targetDomain, 'peer.com');
  assert.equal(row.taskName, '任务A');
  assert.ok(row.publishedAt);
});

test('ensureAnalysisResource：页面不在资源库且有同行域名 → 补录为 ready 资源', async () => {
  const a = assistant();
  await a.ensureAnalysisResource('https://new-blog.com/post', 'peer.com');
  const row = await idbGet('analysis', ['peer.com', 'https://new-blog.com/post']);
  assert.ok(row);
  assert.equal(row.status, 'ready');
  assert.notEqual(row.enabled, false); // 默认启用
});

test('ensureAnalysisResource：同 url 已有记录（任意同行域名）→ 不重复补录', async () => {
  const a = assistant();
  await idbPutAll('analysis', [
    { targetDomain: 'old-peer.com', url: 'https://dup.com/p', status: 'captcha', reason: '原结论', checkedAt: 1 },
  ]);
  await a.ensureAnalysisResource('https://dup.com/p', 'new-peer.com');
  const rows = (await idbGetAll('analysis')).filter((r) => r.url === 'https://dup.com/p');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetDomain, 'old-peer.com'); // 原记录不动
  assert.equal(rows[0].status, 'captcha');
});

test('ensureAnalysisResource：缺少同行域名 → 跳过（主键 [targetDomain, url] 无法归档）', async () => {
  const a = assistant();
  await a.ensureAnalysisResource('https://no-domain.com/p', '');
  const rows = (await idbGetAll('analysis')).filter((r) => r.url === 'https://no-domain.com/p');
  assert.equal(rows.length, 0);
});

test('addCurrentResource：当前标签页 + 输入框同行域名 → 补录为 ready 资源', async () => {
  const a = assistant();
  activeTabUrl = 'https://manual-add.com/post';
  const res = await a.addCurrentResource(' peer.com ');
  assert.equal(res.ok, true);
  const row = await idbGet('analysis', ['peer.com', 'https://manual-add.com/post']);
  assert.ok(row);
  assert.equal(row.status, 'ready');
  assert.notEqual(row.enabled, false); // 默认启用
});

test('addCurrentResource：输入框同行为空 → 拒绝（主键 [targetDomain, url] 无法归档）', async () => {
  const a = assistant();
  activeTabUrl = 'https://no-domain-add.com/p';
  const res = await a.addCurrentResource('  ');
  assert.equal(res.ok, false);
  const rows = (await idbGetAll('analysis')).filter((r) => r.url === 'https://no-domain-add.com/p');
  assert.equal(rows.length, 0);
});

test('addCurrentResource：同 url 已有记录（任意同行域名）→ 拒绝重复添加', async () => {
  const a = assistant();
  activeTabUrl = 'https://dup-add.com/p';
  await idbPutAll('analysis', [
    { targetDomain: 'old-peer.com', url: 'https://dup-add.com/p', status: 'captcha', reason: '原结论', checkedAt: 1 },
  ]);
  const res = await a.addCurrentResource('new-peer.com');
  assert.equal(res.ok, false);
  const rows = (await idbGetAll('analysis')).filter((r) => r.url === 'https://dup-add.com/p');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetDomain, 'old-peer.com'); // 原记录不动
});

test('markAsPublished：当前标签页 + 当前任务目标地址 → 写入 published 记录（含同行域名）', async () => {
  const a = assistant();
  activeTabUrl = 'https://marked.com/post';
  getState().assistantTask = { name: '任务B', targetUrl: 'https://me-b.com', siteIntro: '', mainKeyword: '' };
  const res = await a.markAsPublished(' peer-b.com ');
  assert.equal(res.ok, true);
  const row = await idbGet('published', ['https://marked.com/post', 'https://me-b.com']);
  assert.ok(row);
  assert.equal(row.targetDomain, 'peer-b.com');
  assert.equal(row.taskName, '任务B');
  assert.ok(row.publishedAt);
});

test('markAsPublished：同主键已有记录 → 拒绝覆盖', async () => {
  const a = assistant();
  activeTabUrl = 'https://marked.com/post'; // 上一个用例已落库
  getState().assistantTask = { name: '任务B', targetUrl: 'https://me-b.com', siteIntro: '', mainKeyword: '' };
  const res = await a.markAsPublished('other-peer.com');
  assert.equal(res.ok, false);
  const row = await idbGet('published', ['https://marked.com/post', 'https://me-b.com']);
  assert.equal(row.targetDomain, 'peer-b.com'); // 原记录不动
});

test('markAsPublished：目标地址为空（任务与身份网址都缺）→ 拒绝', async () => {
  const a = assistant();
  activeTabUrl = 'https://no-target.com/p';
  getState().assistantTask = { name: '', targetUrl: '', siteIntro: '', mainKeyword: '' };
  getState().settings.identity.website = '';
  const res = await a.markAsPublished('peer.com');
  assert.equal(res.ok, false);
  const rows = (await idbGetAll('published')).filter((r) => r.url === 'https://no-target.com/p');
  assert.equal(rows.length, 0);
});
