'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { filterIndexEntries, buildIndexTree, renderIndexPage } = require('../index-view');

const labels = {
  title: '目录', search: '文件名', lines: '逐行解释', diagrams: '图表',
  all: '全部', yes: '是', no: '否', blocks: '代码片段', terms: '术语解析',
  refresh: '刷新', empty: '无匹配文件', loading: '加载中', files: '{count} 个文件', line: '第 {line} 行'
};
function entry(id, overrides = {}) {
  return {
    id, name: 'main.js', root: 'D:/project', rootName: 'project', relativePath: 'src/main.js',
    hasLines: false, hasDiagrams: false, blocks: [], lines: [], terms: [], ...overrides
  };
}

test('搜索只匹配文件名，忽略大小写和首尾空格，不匹配路径或内容', () => {
  const entries = [
    entry('one', { name: 'Alpha.js' }),
    entry('two', { root: 'D:/Alpha', relativePath: 'Alpha/main.js', blocks: [{ title: 'Alpha' }], terms: [{ symbol: 'Alpha' }] })
  ];
  assert.deepEqual(filterIndexEntries(entries, { query: ' ALPHA ' }).map(item => item.id), ['one']);
  assert.deepEqual(filterIndexEntries(entries, { query: 'src/' }), []);
  assert.deepEqual(filterIndexEntries(entries, { query: 'missing' }), []);
  assert.deepEqual(filterIndexEntries(entries), entries);
});

test('逐行及图表 all/yes/no 筛选与搜索取交集，不修改输入', () => {
  const entries = [
    entry('neither'), entry('lines', { hasLines: true }),
    entry('diagrams', { hasDiagrams: true }), entry('both', { hasLines: true, hasDiagrams: true }),
    entry('other', { name: 'other.js', hasLines: true, hasDiagrams: true })
  ];
  const before = JSON.stringify(entries);
  for (const lines of ['all', 'yes', 'no']) {
    for (const diagrams of ['all', 'yes', 'no']) {
      const expected = entries.filter(item => item.name === 'main.js'
        && (lines === 'all' || item.hasLines === (lines === 'yes'))
        && (diagrams === 'all' || item.hasDiagrams === (diagrams === 'yes')));
      assert.deepEqual(filterIndexEntries(entries, { query: 'main', lines, diagrams }), expected);
    }
  }
  assert.equal(JSON.stringify(entries), before);
});

test('保留原目录层级，同名多根按绝对路径隔离且无输入变更', () => {
  const entries = [
    entry('nested', { rootName: 'same', relativePath: 'src/deep/main.js' }),
    entry('sibling', { rootName: 'same', name: 'util.js', relativePath: 'src/util.js' }),
    entry('top', { rootName: 'same', name: 'README', relativePath: 'README' }),
    entry('second', { root: 'E:/project', rootName: 'same', relativePath: 'src/main.js' })
  ];
  const before = JSON.stringify(entries);
  const roots = buildIndexTree(entries);
  assert.equal(roots.length, 2);
  assert.deepEqual(roots.map(root => [root.name, root.root]), [['same', 'D:/project'], ['same', 'E:/project']]);
  assert.equal(roots[0].children[0].name, 'src');
  assert.equal(roots[0].children[0].children[0].path, 'src/deep');
  assert.equal(roots[0].children[0].children[0].children[0].entry.id, 'nested');
  assert.equal(roots[0].children[0].children[1].entry.id, 'sibling');
  assert.equal(roots[0].children[1].entry.id, 'top');
  assert.equal(roots[1].children[0].children[0].entry.id, 'second');
  assert.equal(JSON.stringify(entries), before);
  assert.deepEqual(buildIndexTree([]), []);
});

test('共享函数经 toString 可独立执行，无模块外依赖', () => {
  for (const fn of [filterIndexEntries, buildIndexTree]) {
    const isolated = vm.runInNewContext('(' + fn.toString() + ')');
    assert.equal(JSON.stringify(isolated([entry('one')])), JSON.stringify(fn([entry('one')])));
  }
});

function mount(saved = {}) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.isConnected = true; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    fire(type) { this.listeners[type]({ preventDefault() {}, stopPropagation() {} }); }
  }
  const nodes = Object.fromEntries(['query', 'lines', 'diagrams', 'tree', 'count', 'status', 'refresh'].map(id => [id, new Element(id)]));
  nodes.status.textContent = labels.loading;
  const messages = [];
  let state;
  let receive;
  const html = renderIndexPage('abc123', 'zh-CN', labels);
  const script = html.match(/<script nonce="abc123">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => saved, setState: value => { state = JSON.parse(JSON.stringify(value)); }, postMessage: message => { messages.push(JSON.parse(JSON.stringify(message))); } }),
    document: { getElementById: id => nodes[id], createElement: tag => new Element(tag) },
    window: { addEventListener: (type, listener) => { receive = listener; } }
  });
  return { nodes, messages, get state() { return state; }, receive: data => receive({ data }) };
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test('HTML 安全转义、严格 nonce CSP、无外部资源且首屏加载', () => {
  const attack = '</script><img src=x onerror="bad">&\'\u2028\u2029';
  const html = renderIndexPage('nonce-123', 'zh" onload="bad', { ...labels, title: attack, loading: attack });
  assert.match(html, /lang="zh&quot; onload=&quot;bad"/);
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;&#39;/);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.match(html, /default-src 'none'; style-src 'nonce-nonce-123'; script-src 'nonce-nonce-123';/);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.match(html, /<style nonce="nonce-123">/);
  assert.doesNotMatch(html, /<img\b|<link\b|<[^>]*\s(?:src|href)=|unsafe-inline|innerHTML/);
  assert.match(renderIndexPage('abc', 'zh-CN', labels), /role="status">加载中/);
  const poisonedNonce = renderIndexPage("abc'; img-src *; ' bad\"", 'en', labels);
  assert.match(poisonedNonce, /style-src 'nonce-abcimg-srcbad'; script-src 'nonce-abcimg-srcbad';/);
  assert.doesNotMatch(poisonedNonce, /;\s*img-src|nonce="[^"<>]*"\s+bad/);
});

test('动态页分类计数和 opaque id 导航，空分类无按钮，刷新不带导航信息', () => {
  const page = mount();
  assert.equal(page.nodes.status.textContent, labels.loading);
  assert.equal(page.nodes.tree.children.length, 0);
  const entries = [entry('opaque:file', {
    name: '<img src=x>', hasLines: true,
    lines: [{ id: 'opaque:line', line: 7, title: '<script>' }],
    blocks: [{ id: 'opaque:block', title: 'block', start: 8, end: 10, hasDiagram: true }]
  })];
  page.receive({ type: 'index', revision: 42, entries });
  const all = descendants(page.nodes.tree);
  const buttons = all.filter(node => node.tag === 'button');
  assert.deepEqual(buttons.map(button => button.textContent), ['<img src=x>', '第 7 行 — <script>', 'block (第 8 行–10)']);
  assert.ok(all.some(node => node.tag === 'p' && node.textContent === '术语解析 (0)'));
  buttons.forEach(button => button.fire('click'));
  assert.deepEqual(page.messages, [{ action: 'ready' }, ...['opaque:file', 'opaque:line', 'opaque:block'].map(id => ({ action: 'open', revision: 42, id }))]);
  assert.equal(page.nodes.count.textContent, '1 个文件 / 1');
  assert.equal(page.nodes.status.hidden, true);
  page.nodes.refresh.fire('click');
  assert.deepEqual(page.messages.at(-1), { action: 'refresh' });
  page.receive({ type: 'index', revision: 43, entries });
  descendants(page.nodes.tree).find(node => node.tag === 'button').fire('click');
  assert.equal(page.messages.at(-1).revision, 43);
});

test('搜索筛选和折叠持久化，数据更新及过滤重绘保留状态，空状态显示', () => {
  const page = mount({ query: 'main', lines: 'yes', diagrams: 'no', expanded: {} });
  const entries = [entry('one', { hasLines: true }), entry('two', { name: 'other.js', hasDiagrams: true })];
  page.receive({ type: 'index', revision: 1, entries });
  const root = page.nodes.tree.children[0];
  root.open = false;
  root.fire('toggle');
  assert.equal(page.state.query, 'main');
  assert.equal(page.state.lines, 'yes');
  assert.equal(page.state.diagrams, 'no');
  page.receive({ type: 'index', revision: 2, entries });
  assert.equal(page.nodes.tree.children[0].open, false);
  page.nodes.query.value = 'missing';
  page.nodes.query.fire('input');
  assert.equal(page.nodes.tree.children.length, 0);
  assert.equal(page.nodes.status.textContent, labels.empty);
  assert.equal(page.nodes.status.hidden, false);
  assert.equal(page.nodes.count.textContent, '0 个文件 / 2');
  page.nodes.query.value = 'main';
  page.nodes.query.fire('input');
  assert.equal(page.nodes.tree.children[0].open, false);
  const restored = mount(page.state);
  restored.receive({ type: 'index', revision: 3, entries });
  assert.equal(restored.nodes.query.value, 'main');
  assert.equal(restored.nodes.tree.children[0].open, false);
});
