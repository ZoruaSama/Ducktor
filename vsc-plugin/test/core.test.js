'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseRange, parseDucktor, lineHash, resolveBlock, resolveFileTarget, explanationFile, codeFile, findTermMatches } = require('../core');
const { renderMarkdown, renderPanelMarkdown, escapeHtml, renderSourceLines } = require('../rendering');

test('Mermaid 仅显式启用时渲染，绑定复用受控源码命令', async () => {
  const content = '```mermaid\nflowchart LR\n  A[Start] --> B[End]\n  %% ducktor-link {"node":"A","target":"./main.js#1-3"}\n```';
  const diagrams = [];
  const calls = [];
  const markdown = await renderMarkdown(content, () => { throw new Error('Diagram text must not resolve as Markdown links'); }, {
    diagramLinks: diagrams,
    resolveDiagramLink: target => { calls.push(target); return 'command:ducktor.openFile?args'; }
  });
  assert.deepEqual(calls, ['./main.js#1-3']);
  const links = new Map();
  const html = renderPanelMarkdown(markdown, links, { diagrams });
  assert.match(html, /class="ducktor-diagram"/);
  assert.match(html, /data-bindings=.*&quot;node&quot;:&quot;A&quot;/);
  assert.equal(links.get('0'), 'command:ducktor.openFile?args');
  assert.ok(diagrams[0].source.includes('flowchart LR'));
  assert.ok(!diagrams[0].source.includes('ducktor-link'));
  assert.ok(html.includes('ducktor-link'));
  const plain = renderPanelMarkdown(markdown, new Map());
  assert.ok(!plain.includes('ducktor-diagram'));
  assert.ok(plain.includes('ducktor-link'));
  assert.equal(await renderMarkdown(content, () => undefined, { hover: true }), markdown);
});

test('多个 Mermaid 图独立绑定，找不到源码的节点不建立导航', async () => {
  const content = '```mermaid\nclassDiagram\nclass A\n%% ducktor-link {"node":"A","target":"a.js#2"}\n```\n\n```mermaid\nflowchart LR\nA --> B\n%% ducktor-link {"node":"A","target":"missing.js#2"}\n```';
  const diagrams = [];
  const markdown = await renderMarkdown(content, () => undefined, { diagramLinks: diagrams, resolveDiagramLink: target => target.startsWith('missing') ? undefined : 'command:ducktor.openFile?class' });
  const links = new Map();
  const html = renderPanelMarkdown(markdown, links, { diagrams });
  assert.equal((html.match(/class="ducktor-diagram"/g) || []).length, 2);
  assert.equal(links.size, 1);
  assert.deepEqual(diagrams[1].bindings, []);
});

test('不安全图表及无效节点映射安全降级为源码', async () => {
  for (const source of [
    'gantt\ntitle Unsupported chart',
    'flowchart LR\nA --> B\nclick A "https://evil.test"',
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA --> B',
    '---\nconfig: {}\n---\nflowchart LR\nA --> B',
    'flowchart LR\nA["<img src=x onerror=alert(1)>"]',
    'flowchart LR\nA --> B\n%% ducktor-link {"node":"A","target":"command:evil#1"}',
    'flowchart LR\nA --> B\n%% ducktor-link {"node":"A","target":"a.js"}',
    'flowchart LR\nA --> B\n%% ducktor-link not-json',
    'flowchart LR\nA --> B\n%% ducktor-link {"node":"A","target":"a.js#1"}\n%% ducktor-link {"node":"A","target":"b.js#1"}'
  ]) {
    const diagrams = [];
    const markdown = await renderMarkdown('```mermaid\n' + source + '\n```', () => undefined, { diagramLinks: diagrams, resolveDiagramLink: () => { throw new Error('Should not resolve unsafe diagram'); } });
    const links = new Map();
    const html = renderPanelMarkdown(markdown, links, { diagrams });
    assert.match(html, /diagram-error/);
    assert.ok(!html.includes('class="ducktor-diagram"'));
    assert.ok(!html.includes('<img'));
    assert.equal(links.size, 0);
  }
});

test('源码语法高亮保留多行 token、空行与安全转义', () => {
  const source = '/* comment\r\ncontinued */\r\nconst value = `<script>\n${1 + 2}\n</script>`;\n\n';
  const lines = renderSourceLines(source, 'javascript');
  assert.equal(lines.length, source.split(/\r?\n/).length);
  assert.match(lines[0], /hljs-comment/);
  assert.match(lines[1], /hljs-comment/);
  assert.match(lines[2], /hljs-keyword/);
  assert.match(lines[3], /hljs-number/);
  assert.match(lines[4], /hljs-string/);
  assert.ok(!lines.join('').includes('<script>'));
  for (const line of lines) assert.equal((line.match(/<span\b/g) || []).length, (line.match(/<\/span>/g) || []).length);
  assert.equal(lines.map(line => line.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).join('\n'), source.replace(/\r\n/g, '\n'));
});

test('源码高亮识别编辑器语言别名，未知语言保持纯文本', () => {
  for (const language of ['typescriptreact', 'javascriptreact', 'python', 'rust']) {
    const source = language === 'python' ? 'def example(): return 1' : language === 'rust' ? 'fn main() {}' : 'const value = 1;';
    assert.match(renderSourceLines(source, language).join(''), /hljs-/);
  }
  assert.deepEqual(renderSourceLines('<img src="x">\r\n\t&\n', 'unknown-language'), ['&lt;img src=&quot;x&quot;&gt;', '\t&amp;', '']);
  assert.deepEqual(renderSourceLines('', 'javascript'), ['']);
});

test('自定义诊断默认英文，支持中文并保留有效解释内容', () => {
  const source = 'blocks:\n  - range: 1\n    content: 中文解释\n  - range: 0\n    content: invalid\nterms:\n  - symbol: pool\n    content: 中文术语\n  - symbol: invalid\n    content: term\n    aliases: [1]\n';
  const english = parseDucktor(source);
  const chinese = parseDucktor(source, 'zh-CN');
  assert.deepEqual(english.errors, [
    'Explanation block 2: A valid range and string content are required.',
    'Term 2: aliases must be a list of non-empty strings.'
  ]);
  assert.deepEqual(chinese.errors, [
    '解释块 2：需要有效的 range 和字符串 content。',
    '术语 2：aliases 必须为非空字符串列表。'
  ]);
  assert.deepEqual(english.blocks, chinese.blocks);
  assert.deepEqual(english.terms, chinese.terms);
  assert.deepEqual(parseDucktor(source, 'en'), english);
  assert.deepEqual(parseDucktor(source, 'unsupported'), english);
});

test('所有块与术语自定义诊断均支持语言切换', () => {
  const invalidBlocks = [
    'null', '{range: 0, content: text}', '{range: 1, content: text, enabled: yes}',
    '{range: 1, content: text, tags: [1]}', '{range: 1, content: text, anchor: {type: bad}}',
    '{range: 1, content: text, anchor: {type: hash, value: xyz}}',
    '{range: 1, content: text, anchor: {type: text, name: ""}}',
    '{range: 1, content: text, level: L6}'
  ];
  const invalidTerms = [
    'null', '{symbol: "", content: text}', '{symbol: x, content: text, type: bad}',
    '{symbol: x, content: text, scope: bad}', '{symbol: x, content: text, enabled: yes}',
    '{symbol: x, content: text, level: L6}', '{symbol: x, content: text, aliases: [1]}',
    '{symbol: x, content: text, tags: [""]}', '{symbol: x, content: text, scope: local}'
  ];
  for (const [kind, items] of [['blocks', invalidBlocks], ['terms', invalidTerms]]) {
    for (const item of items) {
      const source = `${kind}:\n  - ${item}\n`;
      const english = parseDucktor(source).errors;
      const chinese = parseDucktor(source, 'zh-CN').errors;
      assert.equal(english.length, 1, source);
      assert.equal(chinese.length, 1, source);
      assert.doesNotMatch(english[0], /\p{Script=Han}/u);
      assert.match(chinese[0], /\p{Script=Han}/u);
      assert.notEqual(english[0], chinese[0]);
    }
  }
});

test('顶层自定义错误可翻译，第三方 YAML 错误保持原样', () => {
  assert.throws(() => parseDucktor('hello: world'), { message: 'The .ducktor root must be a blocks/terms object or a list of explanation blocks.' });
  assert.throws(() => parseDucktor('hello: world', 'zh-CN'), { message: '.ducktor 顶层必须是 blocks/terms 对象或解释块列表。' });
  assert.throws(() => parseDucktor('blocks: wrong'), { message: 'blocks and terms must be lists.' });
  assert.throws(() => parseDucktor('blocks: wrong', 'zh-CN'), { message: 'blocks 和 terms 必须为列表。' });
  const errors = ['en', 'zh-CN'].map(language => {
    try { parseDucktor('- range: [broken', language); }
    catch (error) { return error.message; }
  });
  assert.equal(typeof errors[0], 'string');
  assert.equal(errors[0], errors[1]);
});

test('界面文案共用字典支持参数插值与英文回退', () => {
  const { translate } = require('../localization');
  assert.equal(translate('en', 'panelTitle'), 'Ducktor Code Explanation');
  assert.equal(translate('zh-CN', 'panelTitle'), 'Ducktor 代码解释');
  assert.equal(translate('en', 'line', { line: 12 }), 'Line 12');
  assert.equal(translate('zh-CN', 'line', { line: 12 }), '第 12 行');
  assert.equal(translate('en', 'deleteFailed', { error: 'ENOENT' }), 'Failed to delete explanation files: ENOENT');
  assert.equal(translate('zh-CN', 'deleteFailed', { error: 'ENOENT' }), '删除解释文件失败：ENOENT');
  assert.equal(translate('unsupported', 'viewTermExplanation'), translate('en', 'viewTermExplanation'));
});

test('镜像解释路径按工作区根映射，不读取旧旁置或解释目录内文件', () => {
  const root = path.resolve('project');
  const file = path.join(root, 'src', 'main.js');
  const source = path.join(root, '.ducktor', 'src', 'main.js.ducktor');
  assert.equal(explanationFile(file, [root]), source);
  assert.equal(codeFile(source, [root]), file);
  assert.equal(codeFile(file + '.ducktor', [root]), undefined);
  assert.equal(explanationFile(source, [root]), undefined);
  assert.equal(explanationFile(path.resolve('outside', 'main.js'), [root]), undefined);
  assert.equal(codeFile(path.join(root, '.ducktor', '.ducktor', 'main.js.ducktor'), [root]), undefined);
  const nested = path.join(root, 'packages', 'app');
  assert.equal(explanationFile(path.join(nested, 'main.js'), [root, nested]), path.join(nested, '.ducktor', 'main.js.ducktor'));
  assert.equal(resolveFileTarget('../lib/util.js#2', codeFile(source, [root]), [root]).file, path.join(root, 'lib', 'util.js'));
});

test('行号、范围和全文件范围校验', () => {
  assert.deepEqual(parseRange(1), { start: 0, end: 0 });
  assert.deepEqual(parseRange('10-15'), { start: 9, end: 14 });
  assert.deepEqual(parseRange('*'), { all: true });
  for (const range of [0, '-1', '5-3', 1.5, undefined]) assert.equal(parseRange(range), undefined);
});

test('解析 YAML，禁用块不显示，单个错误不阻断其他块', () => {
  const parsed = parseDucktor('- range: 1\n  content: hello\n- range: "*"\n  content: disabled\n  enabled: false\n- range: 0\n  content: invalid\n');
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.throws(() => parseDucktor('hello: world'));
  assert.throws(() => parseDucktor('- range: [broken'));
});

test('逐行说明校验、排序与锚点移动，末尾截断和全文件范围', () => {
  const source = JSON.stringify({ blocks: [{ range: '2-4', anchor: 'anchor', content: '整体', lines: [{ line: 4, content: '末行' }, { line: 2, content: '起行' }] }] });
  const parsed = parseDucktor(source);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.blocks[0].lines.map(item => item.line), [2, 4]);
  const moved = resolveBlock(parsed.blocks[0], ['a', 'b', 'anchor', 'd', 'e']);
  assert.deepEqual(moved.lineExplanations, [{ line: 2, content: '起行' }, { line: 4, content: '末行' }]);
  assert.deepEqual(resolveBlock(parsed.blocks[0], ['a', 'b', 'anchor']).lineExplanations, [{ line: 2, content: '起行' }]);
  const all = parseDucktor(JSON.stringify({ blocks: [{ range: '*', content: '', lines: [{ line: 2, content: '二' }, { line: 9, content: '九' }] }] })).blocks[0];
  assert.deepEqual(resolveBlock(all, ['a', 'b']).lineExplanations, [{ line: 1, content: '二' }]);
  for (const lines of [{}, null, [null], [{ line: 0, content: '' }], [{ line: 1, content: '' }], [{ line: 5, content: '' }], [{ line: 2.5, content: '' }], [{ line: 2, content: 42 }], [{ line: 2, content: '' }, { line: 2, content: '重复' }]]) {
    const input = JSON.stringify({ blocks: [{ range: '2-4', content: '整体', lines }, { range: 1, content: 'valid' }] });
    assert.equal(parseDucktor(input).errors.length, 1);
    assert.equal(parseDucktor(input).blocks.length, 1);
    assert.match(parseDucktor(input, 'zh-CN').errors[0], /lines/);
  }
});

test('文本和哈希锚点重定位并保持范围长度', () => {
  const lines = ['// moved', '', 'function initDB() {', '  return 1;', '}'];
  const block = { range: parseRange('1-3'), anchor: { type: 'text', name: 'function initDB' }, content: '解释' };
  assert.equal(resolveBlock(block, lines).start, 2);
  assert.equal(resolveBlock(block, lines).end, 4);
  const hash = { ...block, anchor: { type: 'hash', value: lineHash(lines[2]).slice(0, 8) } };
  assert.equal(resolveBlock(hash, lines).start, 2);
  assert.equal(lineHash('  x  '), lineHash('x'));
});

test('结构锚点使用语言符号，调用不会抢占声明', () => {
  const block = { range: parseRange(1), anchor: { type: 'function', name: 'initDB' }, content: '' };
  const lines = ['initDB();', 'void initDB() {', '}'];
  assert.equal(resolveBlock(block, lines).start, 1);
  assert.equal(resolveBlock(block, lines, [{ name: 'initDB', type: 'function', start: 2 }]).start, 2);
  assert.equal(resolveBlock(block, ['if (initDB()) {', 'void initDB() { return; }']).start, 1);
  const qualified = { ...block, anchor: { type: 'method', name: 'A.initDB' } };
  assert.equal(resolveBlock(qualified, ['// fallback', 'initDB() { }'], [{ name: 'initDB', container: 'B', type: 'method', start: 1 }]).drifted, true);
});

test('锚点失败降级，越界隐藏，全文件块显示', () => {
  const block = { range: parseRange('1-2'), anchor: { type: 'text', name: 'missing' }, content: '' };
  assert.equal(resolveBlock(block, ['a', 'b']).drifted, true);
  assert.equal(resolveBlock({ ...block, range: parseRange(5) }, ['a']), undefined);
  assert.equal(resolveBlock({ ...block, range: parseRange('*') }, ['a', 'b']).end, 1);
});

test('文件链接限制在工作区，拒绝危险协议和反向范围', () => {
  const root = path.resolve('workspace');
  const source = path.join(root, 'a.cpp.ducktor');
  assert.equal(resolveFileTarget('src/a.cpp#2-4', source, [root]).start, 1);
  for (const target of ['../outside', 'javascript:alert(1)', 'file:///a', 'data:text/plain,x', '//server/file', 'a#5-2']) assert.equal(resolveFileTarget(target, source, [root]), undefined);
});

test('新版 blocks/terms、等级默认值与 local 绑定校验', () => {
  const parsed = parseDucktor(`blocks:
  - range: 1
    content: block
  - range: 2
    content: off
    enabled: false
terms:
  - symbol: pool
    content: term
  - symbol: localPool
    scope: local
    block: 1
    content: local
  - symbol: invalid
    scope: local
    content: missing block
  - symbol: disabled
    content: off
    enabled: false
`);
  assert.equal(parsed.blocks[0].level, 'L3');
  assert.equal(parsed.blocks[0].blockNumber, 1);
  assert.equal(parsed.terms.length, 2);
  assert.equal(parsed.terms[0].scope, 'global');
  assert.equal(parsed.terms[0].level, 'L2');
  assert.equal(parsed.errors.length, 1);
  assert.equal(parseDucktor('terms: []').blocks.length, 0);
  assert.throws(() => parseDucktor('blocks: wrong'));
  for (const field of ['type: bad', 'scope: bad', 'level: L6', 'aliases: [1]', 'tags: false', 'enabled: yes']) {
    assert.equal(parseDucktor(`terms:\n  - symbol: x\n    content: y\n    ${field}`).errors.length, 1);
  }
});

test('关键词边界、别名、大小写和作用范围优先级', () => {
  const terms = [
    { symbol: 'pool', aliases: ['dbPool'], scope: 'global' },
    { symbol: 'pool', aliases: [], scope: 'module' },
    { symbol: 'pool', aliases: [], scope: 'local', localRange: { start: 1, end: 1 } },
    { symbol: 'MAX_RETRY', aliases: [], scope: 'module' },
    { symbol: '$config', aliases: [], scope: 'module' }
  ];
  const matches = findTermMatches(['pool pooled dbPool POOL MAX_RETRY $config', 'pool'], terms);
  assert.deepEqual(matches.map(item => [item.line, item.start, item.end]), [[0, 0, 4], [0, 12, 18], [0, 19, 23], [0, 24, 33], [0, 34, 41], [1, 0, 4]]);
  assert.equal(matches[0].term.scope, 'module');
  assert.equal(matches[1].term.scope, 'global');
  assert.equal(matches.at(-1).term.scope, 'local');
  assert.deepEqual(findTermMatches(['xpool pool2 pool_x 中文pool'], terms), []);
  assert.deepEqual(findTermMatches(['pool'], []), []);
  const priority = findTermMatches(['dbPool'], [{ symbol: 'pool', aliases: ['dbPool'], scope: 'local' }, { symbol: 'dbPool', aliases: [], scope: 'global' }]);
  assert.equal(priority[0].term.symbol, 'dbPool');
  const scopedNames = [{ symbol: 'vscode', aliases: [], scope: 'module' }, { symbol: 'vscode.window', aliases: [], scope: 'local', localRange: { start: 0, end: 0 } }];
  assert.deepEqual(findTermMatches(['vscode.window', 'vscode.window'], scopedNames).map(item => item.term.symbol), ['vscode.window', 'vscode']);
});

const resolver = async target => target.startsWith('javascript:') || target.startsWith('file:') || target.startsWith('command:') ? undefined : target === 'initDB' || target === 'src/a.cpp#2' ? 'command:ducktor.openFile?%5B%5D' : undefined;

test('保留标准 Markdown，扩展链接和强调可渲染', async () => {
  const rendered = await renderMarkdown('### 标题\n\n**加粗** *斜体* ~~删除~~\n\n- [initDB]\n- [src/a.cpp#2]\n\n{!red 警告} {_MAX_RETRY}', resolver);
  assert.match(rendered, /^# 标题\n/);
  assert.match(rendered, /\*\*加粗\*\*/);
  assert.match(rendered, /\[initDB\]\(command:ducktor.openFile/);
  assert.match(rendered, /<span class="ducktor-color-red">警告<\/span>/);
  assert.match(rendered, /<span class="ducktor-underline">MAX\\_RETRY<\/span>/);
});

test('六种颜色与下划线在面板实际渲染，Hover 安全降级，代码内保持字面量', async () => {
  const colors = ['red', 'blue', 'green', 'orange', 'yellow', 'gray'];
  const content = colors.map(color => `{!${color} 提示}`).join(' ') + ' {_MAX_RETRY} `{!red 代码}`';
  const html = renderPanelMarkdown(await renderMarkdown(content, resolver, { heading: false }), new Map());
  for (const color of colors) assert.match(html, new RegExp(`<span class="ducktor-color-${color}">提示</span>`));
  assert.match(html, /<span class="ducktor-underline">MAX_RETRY<\/span>/);
  assert.match(html, /<code>\{!red 代码\}<\/code>/);
  const hover = await renderMarkdown(content, resolver, { hover: true, heading: false });
  assert.doesNotMatch(hover, /<span/);
  assert.match(hover, /提示/);
  assert.match(hover, /MAX\\_RETRY/);
  assert.doesNotMatch(hover, /\*\*/);
  const adjacent = await renderMarkdown('{!red 警告}{!green 警告} {_下划线的测试}', resolver, { hover: true, heading: false });
  assert.equal(adjacent.trim(), '警告警告 下划线的测试');
  assert.equal(renderPanelMarkdown(adjacent, new Map()).trim(), '<p>警告警告 下划线的测试</p>');
  const unsafe = '<span class="ducktor-color-red" onclick="evil()">X</span> <script>evil()</script> {!purple 未知}';
  const safe = renderPanelMarkdown(await renderMarkdown(unsafe, resolver, { heading: false }), new Map());
  assert.doesNotMatch(safe, /<span|<script|onclick="/);
  assert.match(safe, /purple/);
});

test('规范的标准格式与四类链接保留渲染', async () => {
  const targets = [];
  const resolve = async (target, shortcut) => { targets.push([target, shortcut]); return 'command:ducktor.openFile?%5B%5D'; };
  const content = '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n**粗** *斜* ***粗斜*** ~~删~~\n\n- 一\n  - 嵌套\n\n1. 二\n2. 三\n\n> 引用\n\n`代码`\n\n```js\nconst value = 1;\n```\n\n[src/auth.ts#12-20] [createPool:ts] [UserService.validate:js] <https://example.com/auth> [文档](../docs/auth.md)';
  const html = renderPanelMarkdown(await renderMarkdown(content, resolve, { heading: false }), new Map());
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'strong', 'em', 'del', 'ul', 'ol', 'blockquote', 'code', 'pre']) assert.ok(html.includes(`<${tag}`), tag);
  assert.equal((html.match(/data-link=/g) || []).length, 5);
  assert.deepEqual(targets, [['src/auth.ts#12-20', true], ['createPool:ts', true], ['UserService.validate:js', true], ['https://example.com/auth', false], ['../docs/auth.md', false]]);
});

test('Hover 使用正文圆点，侧栏保持语义列表，正文后直接跟列表也独立成段', async () => {
  const content = 'Title\n正文。\n- **第一项** [initDB]\n- 第二项';
  const hover = await renderMarkdown(content, resolver, { hover: true });
  assert.match(hover, /正文。\n\n+• \*\*第一项\*\*/);
  assert.match(hover, /\n\n• 第二项/);
  const hoverHtml = renderPanelMarkdown(hover, new Map());
  assert.doesNotMatch(hoverHtml, /<ul>|<li>/);
  assert.match(hoverHtml, /<p>• <strong>第一项<\/strong>/);
  assert.match(hoverHtml, /data-link="0"/);
  const panelHtml = renderPanelMarkdown(await renderMarkdown(content, resolver), new Map());
  assert.match(panelHtml, /<ul>/);
  assert.equal((panelHtml.match(/<li>/g) || []).length, 2);
});

test('Hover 的嵌套、引用、有序列表及代码保留内容与可见标记', async () => {
  const content = 'Title\n\n- 父项\n  - 子项\n  - 子项二\n\n3. 三\n4. 四\n\n> - 引用项\n\n- 代码项\n\n  ```js\n  - not a list\n  ```\n\n- ```js\n  const value = 1;\n  ```';
  const hover = await renderMarkdown(content, resolver, { hover: true });
  assert.match(hover, /• 父项\n\n\u00a0\u00a0• 子项/);
  assert.match(hover, /3\\\. 三\n\n4\\\. 四/);
  assert.match(hover, /> • 引用项/);
  assert.match(hover, /```js\n- not a list\n```/);
  const html = renderPanelMarkdown(hover, new Map());
  assert.doesNotMatch(html, /<ul>|<ol>|<li>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<p>3\. 三<\/p>/);
  assert.equal((html.match(/<pre><code/g) || []).length, 2);
  assert.match(html, /- not a list/);
});

test('解释首行默认 H1，保留后续正文与标题格式', async () => {
  const rendered = await renderMarkdown('\r\nresolveBlock：收集候选位置\r\n根据锚点查找起始行。\r\n\r\n## 细节', resolver);
  assert.match(rendered.trimStart(), /^# resolveBlock：收集候选位置\n\n根据锚点查找起始行。/);
  assert.match(rendered, /## 细节/);
  assert.match(renderPanelMarkdown(rendered, new Map()), /<h1>resolveBlock：收集候选位置<\/h1>/);
  const code = await renderMarkdown('```python\nprint(1)\n```', resolver);
  assert.match(code, /^```python/);
  assert.equal((await renderMarkdown('', resolver)).trim(), '');
});

test('逐行说明可关闭自动标题，保留完整 Markdown', async () => {
  const markdown = await renderMarkdown('读取 `anchor`。\n\n- 校验类型\n- 校验名称', resolver, { heading: false });
  const html = renderPanelMarkdown(markdown, new Map());
  assert.doesNotMatch(html, /<h1>/);
  assert.match(html, /<p>读取 <code>anchor<\/code>。<\/p>/);
  assert.match(html, /<ul>/);
  assert.match(html, /校验名称/);
});

test('代码中的扩展语法不解析，未匹配符号降为文本', async () => {
  const rendered = await renderMarkdown('`[initDB]`\n\n```cpp\n{!red example}\n```\n\n[missing]', resolver);
  assert.doesNotMatch(rendered, /command:/);
  assert.match(rendered, /\[initDB\]/);
  assert.match(rendered, /\{!red example\}/);
  assert.match(rendered, /missing/);
});

test('行内代码保留引号、特殊字符与原本的实体文本，不二次转义', async () => {
  const samples = ["{ type: 'text', name: ... }", '<tag a="x"> & value', '&#39; &amp; &lt; &#x27;', 'a ` b', '  padded  '];
  for (const sample of samples) {
    const fence = sample.includes('`') ? '``' : '`';
    const code = `${fence}${sample}${fence}`;
    const rendered = await renderMarkdown('Title\n\n转换成 ' + code + '。', resolver);
    assert.ok(rendered.includes(code), rendered);
    const expected = require('marked').marked.parse('转换成 ' + code + '。');
    assert.ok(renderPanelMarkdown(rendered, new Map()).includes(expected), rendered);
  }
  const rendered = await renderMarkdown("Title\n\n`{ type: 'text', name: ... }`", resolver);
  assert.doesNotMatch(rendered, /&#39;/);
  assert.doesNotMatch(renderPanelMarkdown(rendered, new Map()), /&amp;#39;/);
});

test('正文与 Markdown 转义字符不提前变成 HTML 实体', async () => {
  const rendered = await renderMarkdown('Title\n\n"quoted" & value \\> end \\*literal\\*', resolver);
  assert.match(rendered, /"quoted" & value/);
  assert.doesNotMatch(rendered, /&quot;|&amp;|&gt;/);
  const html = renderPanelMarkdown(rendered, new Map());
  assert.match(html, /&quot;quoted&quot; &amp; value &gt; end \*literal\*/);
  assert.doesNotMatch(html, /<em>|&amp;(?:quot|amp|gt);/);
});

test('行内代码中的 HTML 和命令保持纯文本，代码块保留实体字面量', async () => {
  const rendered = await renderMarkdown('Title\n\n`<script>evil()</script> [run](command:evil.run)`\n\n```html\n&#39; <img onerror="evil()">\n```', resolver);
  const links = new Map();
  const html = renderPanelMarkdown(rendered, links);
  assert.doesNotMatch(html, /<script>|<img|data-link=/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;#39;/);
  assert.equal(links.size, 0);
});

test('危险链接、原始 HTML、图片和引用链接均不可执行', async () => {
  const rendered = await renderMarkdown('[bad](javascript:alert%281%29)\n\n[run](command:workbench.action.closeWindow)\n\n<img src="x" onerror="evil()">\n\n![pic](https://evil/image)\n\n[ref][danger]\n\n[danger]: file:///etc/passwd', resolver);
  assert.doesNotMatch(rendered, /\]\((?:javascript|command|file):/);
  assert.doesNotMatch(rendered, /<img/);
  assert.doesNotMatch(rendered, /!\[/);
});

test('面板保留 Markdown，将受控链接转换为消息并转义原始 HTML', async () => {
  const markdown = await renderMarkdown('## 解释\n\n**重点** [initDB]\n\n<img src="x" onerror="evil()">\n\n```js\n<script>evil()</script>\n```', resolver);
  const links = new Map();
  const html = renderPanelMarkdown(markdown, links);
  assert.match(html, /<h1>解释<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /data-link="0"/);
  assert.equal(links.get('0'), 'command:ducktor.openFile?%5B%5D');
  assert.doesNotMatch(html, /<script>|<img|href="command:/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(escapeHtml('<a "x">&'), '&lt;a &quot;x&quot;&gt;&amp;');
});
