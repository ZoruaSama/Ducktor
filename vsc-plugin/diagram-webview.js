'use strict';
import mermaid from 'mermaid';

const nonce = document.currentScript.nonce;
const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', htmlLabels: false, flowchart: { htmlLabels: false }, suppressErrorRendering: true, maxTextSize: 50000 });

async function renderDiagrams() {
  let index = 0;
  for (const container of document.querySelectorAll('.ducktor-diagram')) {
    const code = container.dataset.diagramSource;
    const id = `ducktor-diagram-${index++}`;
    const staging = document.createElement('div');
    staging.style.cssText = 'position:absolute;left:-10000px;opacity:0;pointer-events:none';
    document.body.append(staging);
    try {
      const { svg } = await mermaid.render(id, code, staging);
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = parsed.documentElement;
      if (root.localName !== 'svg') throw new Error('Invalid diagram output');
      // Only our binding map can introduce interactive navigation.
      for (const element of root.querySelectorAll('*')) {
        if (['script', 'foreignObject', 'a', 'image', 'use'].includes(element.localName)) { element.remove(); continue; }
        for (const attribute of Array.from(element.attributes)) {
          if (/^on/i.test(attribute.name) || /(?:href|data-link|data-action|data-source|data-line|data-mode)/i.test(attribute.name)) element.removeAttribute(attribute.name);
        }
        if (element.localName === 'style') element.setAttribute('nonce', nonce);
      }
      container.replaceChildren(document.importNode(root, true));
      const bindings = JSON.parse(container.dataset.bindings);
      for (const binding of bindings) {
        const nodes = container.querySelectorAll('[id], [data-id]');
        const node = Array.from(nodes).find(element => element.getAttribute('data-id') === binding.node || element.id === binding.node || ['flowchart', 'classId'].some(type => { const prefix = `${id}-${type}-${binding.node}-`; return element.id.startsWith(prefix) && /^\d+$/.test(element.id.slice(prefix.length)); }));
        if (!node) continue;
        node.dataset.link = binding.link;
        node.setAttribute('role', 'link');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-label', `${binding.node}: ${document.documentElement.lang === 'zh-CN' ? '跳转至源码' : 'Go to source'}`);
        node.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); node.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
        });
      }
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'diagram-error';
      message.textContent = `${document.documentElement.lang === 'zh-CN' ? '图表渲染失败' : 'Diagram rendering failed'}: ${error.message}`;
      container.prepend(message);
    } finally { staging.remove(); }
  }
}
renderDiagrams();
