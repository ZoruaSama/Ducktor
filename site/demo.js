(() => {
  'use strict';
  const scriptBase = new URL('.', document.currentScript.src);
  const zh = /^zh/i.test(document.documentElement.lang);
  const t = (cn, en) => zh ? cn : en;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (cls, text, action) => {
    const node = el('button', cls, text);
    node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
  };

  // Read the supplied sidecar's block scalars, ranges, terms and line entries.
  function parseSidecar(text) {
    const data = { blocks: [], terms: [] };
    const lines = text.replace(/\r/g, '').split('\n');
    let section = '', entry = null, lineEntry = null;
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i];
      if (s === 'blocks:' || s === 'terms:') { section = s.slice(0, -1); continue; }
      let m = s.match(/^  - range: "(\d+)-(\d+)"/);
      if (m) { entry = { start: +m[1], end: +m[2], content: '', lines: [] }; data.blocks.push(entry); lineEntry = null; continue; }
      m = s.match(/^  - symbol: (.+)/);
      if (m) { entry = { symbol: m[1], content: '' }; data.terms.push(entry); lineEntry = null; continue; }
      m = s.match(/^      - line: (\d+)/);
      if (m) { lineEntry = { line: +m[1], content: '' }; entry.lines.push(lineEntry); continue; }
      m = s.match(/^        content: (.+)/);
      if (m && lineEntry) { lineEntry.content = m[1]; continue; }
      if (s === '    content: |') {
        const content = [];
        while (i + 1 < lines.length && (lines[i + 1].startsWith('      ') || !lines[i + 1].trim())) content.push(lines[++i].slice(6));
        entry.content = content.join('\n').trim();
      }
    }
    return data;
  }

  async function mount() {
    const root = document.getElementById('interactive-demo');
    if (!root) return;
    root.textContent = t('正在载入真实案例…', 'Loading the real-world example…');
    let code, data;
    try {
      const responses = await Promise.all(['group_concat.h', 'group_concat.h.ducktor'].map(name => fetch(new URL(name, scriptBase))));
      if (responses.some(r => !r.ok)) throw new Error('Case assets unavailable');
      const texts = await Promise.all(responses.map(r => r.text()));
      code = texts[0].trimEnd().replace(/\r/g, '').split('\n');
      data = parseSidecar(texts[1]);
    } catch (error) {
      root.textContent = t('案例载入失败，请通过 HTTP 服务打开页面后重试。', 'Could not load the example. Open this page through an HTTP server and retry.');
      return;
    }
    let mode = 'blocks', current = data.blocks[0], panelOpen = false;
    let selection = [], tooltipTrigger = null;
    let hoverTimer, hoverTrigger = null;
    let sourceMode = 'blocks', sourceScroll = 0, lineScroll = 0;
    let lineTab = null;
    const annotations = new Map(data.blocks.flatMap(b => b.lines.map(l => [l.line, l.content])));
    const terms = new Map(data.terms.map(term => [term.symbol, term.content]));
    const rows = new Map();
    const shell = el('div', 'demo-shell');
    const notice = el('div', 'demo-notice', t('真实案例 · OceanBase GROUP_CONCAT / LISTAGG', 'Real-world case · OceanBase GROUP_CONCAT / LISTAGG'));
    notice.append(el('span', '', t('预览效果', 'Preview')));
    const titlebar = el('div', 'demo-titlebar');
    titlebar.append(el('span', 'demo-window-dots', '● ● ●'), el('span', 'demo-window-title', 'group_concat.h — Ducktor — Visual Studio Code'));
    const toolbar = el('div', 'demo-toolbar');
    toolbar.append(el('span', 'demo-toolbar-label', t('在真实实现中探索', 'Explore a real implementation')));
    const modes = [['terms', t('术语', 'Terms')], ['blocks', t('代码段', 'Code blocks')], ['lines', t('逐行解释', 'Line by line')]];
    const controls = modes.map(([id, label]) => {
      const control = button('demo-mode', label, () => setMode(id));
      control.dataset.mode = id;
      toolbar.append(control);
      return control;
    });
    const choose = el('select', 'demo-block-select');
    choose.setAttribute('aria-label', t('定位代码块', 'Locate code block'));
    data.blocks.forEach(b => {
      const name = b.content.match(/^### (.+)/)?.[1] || 'GROUP_CONCAT';
      const option = el('option', '', `${b.start}–${b.end} · ${name}`);
      option.value = String(b.start);
      choose.append(option);
    });
    choose.addEventListener('change', () => openBlock(data.blocks.find(b => b.start === +choose.value), true));
    toolbar.append(choose);
    const workspace = el('div', 'demo-workspace');
    const activity = el('div', 'demo-activity', '\n⌕\n⑂');
    const filesIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    filesIcon.setAttribute('viewBox', '0 0 24 24');
    filesIcon.setAttribute('width', '22');
    filesIcon.setAttribute('height', '22');
    filesIcon.style.marginTop = '14px';
    filesIcon.innerHTML = '<g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3h11v15H8z"/><path d="M5 6H3v15h11v-2"/></g>';
    activity.prepend(filesIcon);
    activity.setAttribute('aria-hidden', 'true');
    const explorer = el('div', 'demo-explorer');
    explorer.append(el('div', 'demo-explorer-title', 'EXPLORER'), el('div', 'demo-folder', '⌄ OCEANBASE'), el('div', 'demo-folder', '  ⌄ src / share'), el('div', 'demo-folder', '    ⌄ aggregate'), el('div', 'demo-file', 'C++ group_concat.h'), el('div', 'demo-folder', 'group_concat.h.ducktor'));
    const editor = el('div', 'demo-editor');
    const tabs = el('div', 'demo-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', t('编辑器标签页', 'Editor tabs'));
    const sourceTab = button('demo-tab', 'C++  group_concat.h', () => setMode(sourceMode));
    sourceTab.setAttribute('role', 'tab');
    sourceTab.setAttribute('aria-selected', 'true');
    const tabNote = el('span', 'demo-tab-note', t('完整源码 · 只读', 'Full source · Read only'));
    tabs.append(sourceTab, tabNote);
    const crumb = el('div', 'demo-breadcrumb', 'src › share › aggregate › group_concat.h');
    const lens = button('demo-codelens', t('▣ 逐行解释', '▣ Line-by-line explanation'), () => { setMode('lines'); locate(36, 65); });
    const stage = el('div', 'demo-stage');
    const content = el('div', 'demo-content');
    const source = el('div', 'demo-source');
    source.setAttribute('aria-label', t('完整 GROUP_CONCAT 源码', 'Complete GROUP_CONCAT source'));
    source.tabIndex = 0;
    const panel = el('aside', 'demo-panel');
    panel.setAttribute('aria-label', t('Ducktor 右侧解释面板', 'Ducktor right-hand explanation panel'));
    panel.hidden = true;
    const hover = el('aside', 'demo-hover');
    hover.setAttribute('aria-label', t('代码块悬浮解释', 'Code block hover explanation'));
    const tooltip = el('aside', 'demo-tooltip');
    tooltip.id = 'demo-term-tooltip';
    tooltip.hidden = true;
    const status = el('span', 'demo-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const statusbar = el('div', 'demo-statusbar');
    statusbar.append(status, el('span', '', 'C++ · UTF-8 · OceanBase CE · Mulan PubL v2'));
    const meta = el('div', 'demo-case-meta', t('解释原文来自提供的 .ducktor 文件（中文）；保留其中“推断 / 尚待核实”的标注。', 'Explanation content is the supplied Chinese .ducktor sidecar; inferred / unverified notes are preserved.'));
    const downloads = el('span', 'demo-download');
    ['group_concat.h', 'group_concat.h.ducktor'].forEach(name => {
      const link = el('a', '', name);
      link.href = new URL(name, scriptBase).href;
      link.download = name;
      downloads.append(link);
    });
    meta.append(downloads);
    content.append(source, panel);
    stage.append(hover, content, tooltip);
    editor.append(tabs, crumb, lens, stage);
    workspace.append(activity, explorer, editor);
    shell.append(notice, titlebar, toolbar, workspace, statusbar, meta);
    root.replaceChildren(shell);

    function clearSelection() {
      selection = [];
      rows.forEach(row => row.classList.remove('demo-code-selected'));
      root.querySelectorAll('.demo-flow-node').forEach(n => n.setAttribute('aria-pressed', 'false'));
      status.textContent = t('已清除代码高亮', 'Code highlights cleared');
    }
    function locate(start, end = start) {
      selection = [start, end];
      rows.forEach((row, n) => row.classList.toggle('demo-code-selected', n >= start && n <= end));
      const row = rows.get(start);
      if (row) source.scrollTop = Math.max(0, row.offsetTop - source.offsetTop - 55);
      status.textContent = `group_concat.h · ${t('第', 'Lines')} ${start}–${end} ${t('行', '')}`;
    }
    const referenceBubble = el('div', 'demo-reference-bubble');
    referenceBubble.setAttribute('role', 'status');
    referenceBubble.setAttribute('aria-live', 'polite');
    referenceBubble.hidden = true;
    stage.append(referenceBubble);
    let referenceTimer;
    function navigate(target) {
      clearTimeout(referenceTimer);
      referenceBubble.hidden = true;
      const local = target.match(/(?:^|\/)group_concat\.h#(\d+)(?:-(\d+))?$/);
      if (local) locate(+local[1], +(local[2] || local[1]));
      else {
        const message = t('此引用指向其他源文件，本网页未包含：', 'This reference points to another source file not bundled in this preview: ') + target;
        status.textContent = message;
        referenceBubble.textContent = message;
        referenceBubble.hidden = false;
        referenceTimer = setTimeout(() => { referenceBubble.hidden = true; }, 4500);
      }
    }
    function inline(parent, text) {
      const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      let from = 0;
      for (const match of text.matchAll(pattern)) {
        parent.append(document.createTextNode(text.slice(from, match.index)));
        if (match[0].startsWith('`')) parent.append(el('code', '', match[0].slice(1, -1)));
        else {
          const parts = match[0].match(/^\[([^\]]+)\]\(([^)]+)\)$/);
          const link = el('a', '', parts[1]);
          link.href = '#interactive-demo';
          link.title = parts[2];
          link.addEventListener('click', event => { event.preventDefault(); navigate(parts[2]); });
          parent.append(link);
        }
        from = match.index + match[0].length;
      }
      parent.append(document.createTextNode(text.slice(from)));
    }
    function diagram(text) {
      const nodes = new Map(), edges = [], targets = new Map();
      const lines = text.split('\n');
      lines.forEach(line => {
        const mapping = line.match(/%% ducktor-link (.+)/);
        if (mapping) { const obj = JSON.parse(mapping[1]); targets.set(obj.node, obj.target); return; }
        if (!line.includes('-->')) return;
        // Split at the arrow so edge captions cannot be mistaken for node IDs.
        const pair = line.trim().split(/\s*-->\s*(?:\|[^|]*\|\s*)?/);
        const parse = s => {
          const m = s.match(/^([A-Za-z]\w*)(?:\["([^"]+)"\]|\{"([^"]+)"\})?/);
          if (!m) return null;
          if (!nodes.has(m[1]) || m[2] || m[3]) nodes.set(m[1], { id: m[1], label: m[2] || m[3] || nodes.get(m[1])?.label || m[1], level: 0 });
          return m[1];
        };
        const a = parse(pair[0]), b = parse(pair[1] || '');
        if (a && b) edges.push([a, b, line.match(/-->\|([^|]+)\|/)?.[1] || '']);
      });
      for (let i = 0; i < nodes.size; i++) edges.forEach(([a, b]) => { nodes.get(b).level = Math.max(nodes.get(b).level, nodes.get(a).level + 1); });
      const levels = new Map();
      nodes.forEach(node => { if (!levels.has(node.level)) levels.set(node.level, []); levels.get(node.level).push(node); });
      const width = 600, height = (Math.max(...levels.keys()) + 1) * 95 + 20;
      levels.forEach((group, level) => group.forEach((node, i) => { node.x = width * (i + 1) / (group.length + 1); node.y = level * 95 + 12; node.w = Math.min(230, width / group.length - 20); }));
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', t('点击流程图节点定位源码', 'Select a diagram node to locate source'));
      svg.classList.add('demo-flow');
      edges.forEach(([a, b, caption]) => {
        const from = nodes.get(a), to = nodes.get(b);
        const path = document.createElementNS(ns, 'path');
        const y = to.y - 8;
        path.setAttribute('d', `M${from.x} ${from.y + 52} L${to.x} ${y} m-4 -6 l4 6 l4 -6`);
        path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#91a5b8'); path.setAttribute('stroke-width', '1.5');
        svg.append(path);
        if (caption) {
          const label = document.createElementNS(ns, 'text');
          label.setAttribute('x', (from.x + to.x) / 2 + 7); label.setAttribute('y', (from.y + 52 + y) / 2);
          label.setAttribute('fill', '#60768c'); label.setAttribute('font-size', '13'); label.textContent = caption; svg.append(label);
        }
      });
      nodes.forEach(node => {
        const box = document.createElementNS(ns, 'foreignObject');
        box.setAttribute('x', node.x - node.w / 2); box.setAttribute('y', node.y); box.setAttribute('width', node.w); box.setAttribute('height', 52);
        const control = button('demo-flow-node', node.label, () => {
          root.querySelectorAll('.demo-flow-node').forEach(n => n.setAttribute('aria-pressed', 'false'));
          control.setAttribute('aria-pressed', 'true');
          if (targets.has(node.id)) navigate(targets.get(node.id));
          else status.textContent = node.label + t(' · 此节点未绑定源码范围', ' · No source range is mapped to this node');
        });
        control.setAttribute('aria-pressed', 'false');
        if (targets.has(node.id)) control.title = targets.get(node.id);
        box.append(control); svg.append(box);
      });
      const wrap = el('div', 'demo-diagram');
      wrap.append(el('p', 'demo-flow-caption', t('交互图 · 点击已绑定节点，高亮并滚动到真实源码', 'Interactive diagram · Mapped nodes highlight and scroll to real source')), svg);
      return wrap;
    }
    function markdown(text) {
      const wrap = el('div', 'demo-markdown');
      wrap.lang = 'zh-CN';
      const lines = text.split('\n');
      let list = null;
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i];
        if (s === '```mermaid') {
          const body = []; while (++i < lines.length && lines[i] !== '```') body.push(lines[i]);
          wrap.append(diagram(body.join('\n'))); list = null; continue;
        }
        if (!s.trim()) { list = null; continue; }
        const heading = s.match(/^(#{1,3}) (.+)/), item = s.match(/^(?:- |\d+\. )(.+)/);
        if (heading) { const h = el('h' + (heading[1].length + 1)); inline(h, heading[2]); wrap.append(h); list = null; }
        else if (item) { if (!list) { list = el(/^\d/.test(s) ? 'ol' : 'ul'); wrap.append(list); } const li = el('li'); inline(li, item[1]); list.append(li); }
        else { const p = el('p'); inline(p, s); wrap.append(p); list = null; }
      }
      return wrap;
    }
    function actions(container, floating) {
      const bar = el('div', 'demo-actions');
      bar.append(button('', t('高亮代码块', 'Highlight code block'), () => locate(current.start, current.end)), button('', t('打开右侧面板', 'Open right-hand panel'), () => { panelOpen = true; hover.hidden = true; renderPanel(); }), button('', t('清除', 'Clear'), clearSelection), button('', t('清除全部', 'Clear All'), () => { clearSelection(); hideTerm(); hover.hidden = true; panelOpen = false; renderPanel(); }));
      const close = button('demo-close', '×', () => { if (floating) hover.hidden = true; else { panelOpen = false; renderPanel(); } });
      close.setAttribute('aria-label', t('关闭解释窗口', 'Close explanation window'));
      bar.append(close); container.append(bar);
    }
    function renderPanel() {
      panel.hidden = !panelOpen;
      stage.classList.toggle('demo-panel-open', panelOpen);
      panel.replaceChildren();
      if (panelOpen) { actions(panel, false); panel.append(el('div', 'demo-panel-heading', `${current.start}–${current.end} · Ducktor`), markdown(current.content)); }
    }
    function cancelHoverDismiss() {
      clearTimeout(hoverTimer);
    }
    function dismissHover() {
      cancelHoverDismiss();
      hover.hidden = true;
      hoverTrigger = null;
    }
    function scheduleHoverDismiss() {
      cancelHoverDismiss();
      hoverTimer = setTimeout(() => {
        if (hover.matches(':hover') || hoverTrigger?.matches(':hover')) return;
        dismissHover();
      }, 200);
    }
    hover.addEventListener('pointerenter', cancelHoverDismiss);
    hover.addEventListener('pointerleave', scheduleHoverDismiss);
    hover.addEventListener('focusin', cancelHoverDismiss);
    hover.addEventListener('focusout', scheduleHoverDismiss);

    function positionHover(trigger) {
      if (hover.hidden || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const bounds = stage.getBoundingClientRect();
      const gap = 6;
      const above = anchor.top - bounds.top - gap;
      const below = bounds.bottom - anchor.bottom - gap;
      const placeAbove = above >= 100 || above >= below;
      hover.style.maxHeight = Math.min(390, Math.max(0, placeAbove ? above : below)) + 'px';
      const left = anchor.left - bounds.left;
      hover.style.left = Math.max(8, Math.min(left, stage.clientWidth - hover.offsetWidth - 8)) + 'px';
      hover.style.top = (placeAbove ? anchor.top - bounds.top - hover.offsetHeight - gap : anchor.bottom - bounds.top + gap) + 'px';
    }

    function openBlock(block, scroll = false) {
      cancelHoverDismiss();
      current = block; choose.value = String(block.start);
      hideTerm();
      if (mode === 'lines') setMode('blocks');
      hover.replaceChildren(); actions(hover, true); hover.append(markdown(block.content));
      hover.hidden = panelOpen;
      renderPanel();
      if (scroll) locate(block.start, block.end);
      const anchorRow = block.start === 24 ? 25 : block.start === 36 ? 37 : block.start === 349 ? 350 : block.start;
      positionHover(hoverTrigger || rows.get(anchorRow)?.querySelector('.demo-inline-hint'));
      status.textContent = `Ducktor · ${block.start}–${block.end}`;
    }
    function hideTerm() {
      tooltip.hidden = true;
      if (tooltipTrigger) tooltipTrigger.setAttribute('aria-expanded', 'false');
      tooltipTrigger = null;
    }
    function showTerm(symbol, trigger) {
      hideTerm(); tooltipTrigger = trigger; trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-describedby', tooltip.id);
      const close = button('demo-close', '×', hideTerm);
      close.setAttribute('aria-label', t('关闭术语解释', 'Close term explanation'));
      tooltip.replaceChildren(close, el('strong', 'demo-term-title', symbol), markdown(terms.get(symbol)));
      tooltip.hidden = false;
      const r = trigger.getBoundingClientRect(), s = stage.getBoundingClientRect();
      tooltip.style.left = Math.max(8, Math.min(stage.clientWidth - tooltip.offsetWidth - 8, r.left - s.left)) + 'px';
      tooltip.style.top = Math.max(8, Math.min(stage.clientHeight - tooltip.offsetHeight - 8, r.bottom - s.top + 6)) + 'px';
      status.textContent = t('术语：', 'Term: ') + symbol;
    }
    function renderSource() {
      const oldTop = source.scrollTop;
      source.replaceChildren(); rows.clear();
      let inComment = false;
      code.forEach((text, index) => {
        const n = index + 1, row = el('div', 'demo-code-row'); row.dataset.line = String(n);
        const number = button('demo-line-number', String(n), () => locate(n));
        number.setAttribute('aria-label', t('定位第 ', 'Locate line ') + n);
        const line = el('code', 'demo-code-text');
        const chunks = text.match(/\/\/.*|\/\*.*|"(?:\\.|[^"\\])*"|'[^']*'|\b[A-Za-z_]\w*\b|\b\d+\b|[^A-Za-z_\d"']+/g) || [];
        chunks.forEach(chunk => {
          if (chunk.startsWith('/*')) inComment = true;
          const comment = inComment || chunk.startsWith('//');
          if (!comment && terms.has(chunk)) {
            const term = button('demo-term', chunk, () => showTerm(chunk, term));
            term.setAttribute('aria-expanded', 'false'); term.setAttribute('aria-label', t('查看术语：', 'Explain term: ') + chunk);
            term.addEventListener('pointerenter', () => showTerm(chunk, term)); term.addEventListener('focus', () => showTerm(chunk, term)); line.append(term);
          } else {
            const kind = comment ? 'comment' : /^(template|typename|class|final|public|protected|static|const|constexpr|using|int|int32_t|int64_t|uint64_t|char|bool|inline|if|else|for|while|return|namespace|void|virtual|override|true|false|nullptr)$/.test(chunk) ? 'keyword' : /^\d/.test(chunk) ? 'number' : /^["']/.test(chunk) ? 'string' : '';
            line.append(el('span', kind ? 'demo-token-' + kind : '', chunk));
          }
          if (chunk.includes('*/')) inComment = false;
        });
        const block = data.blocks.find(b => (b.start === 24 ? 25 : b.start === 36 ? 37 : b.start === 349 ? 350 : b.start) === n);
        if (block) {
          const show = () => {
            if (mode === 'lines') return;
            hoverTrigger = hint;
            openBlock(block);
          };
          const hint = button('demo-inline-hint', ' Ducktor', show);
          const logo = el('img', 'demo-inline-logo');
          logo.src = new URL('icon.png', scriptBase).href;
          logo.alt = '';
          hint.prepend(logo);
          hint.setAttribute('aria-label', t('查看代码段解释，第 ', 'Open block explanation, lines ') + block.start + '–' + block.end);
          hint.addEventListener('pointerenter', show);
          hint.addEventListener('pointerleave', scheduleHoverDismiss);
          hint.addEventListener('focus', show);
          hint.addEventListener('blur', scheduleHoverDismiss);
          line.append(hint);
        }
        row.append(number, line);
        if (mode === 'lines') { const detail = el('div', 'demo-line-explanation'); if (annotations.has(n)) inline(detail, annotations.get(n)); row.append(detail); }
        if (selection.length && n >= selection[0] && n <= selection[1]) row.classList.add('demo-code-selected');
        rows.set(n, row); source.append(row);
      });
      source.scrollTop = oldTop;
    }
    function setMode(next) {
      if (mode === 'lines') lineScroll = source.scrollTop;
      else { sourceScroll = source.scrollTop; sourceMode = mode; }
      mode = next;
      if (mode !== 'lines') sourceMode = mode;
      hideTerm(); dismissHover();
      if (mode === 'lines' && !lineTab) {
        lineTab = button('demo-tab', t('▣ group_concat.h · 逐行解释', '▣ group_concat.h · Line by line'), () => setMode('lines'));
        lineTab.setAttribute('role', 'tab');
        tabs.insertBefore(lineTab, tabNote);
      }
      sourceTab.setAttribute('aria-selected', String(mode !== 'lines'));
      if (lineTab) lineTab.setAttribute('aria-selected', String(mode === 'lines'));
      controls.forEach(c => c.setAttribute('aria-pressed', String(c.dataset.mode === mode)));
      content.dataset.mode = mode;
      lens.hidden = mode === 'lines';
      if (mode !== 'blocks') { panelOpen = false; renderPanel(); }
      renderSource();
      source.scrollTop = mode === 'lines' ? lineScroll : sourceScroll;
      status.textContent = t('当前模式：', 'Mode: ') + modes.find(([id]) => id === mode)[1];
    }
    root.addEventListener('keydown', event => { if (event.key === 'Escape') { hideTerm(); hover.hidden = true; } });
    root.addEventListener('click', event => { if (!tooltip.contains(event.target) && event.target !== tooltipTrigger) hideTerm(); });
    source.addEventListener('scroll', () => { hideTerm(); dismissHover(); });
    window.addEventListener('resize', () => { hideTerm(); dismissHover(); });
    setMode('blocks');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
