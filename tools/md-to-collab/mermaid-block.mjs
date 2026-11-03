/**
 * Mermaid 节点定义（导入管线专用，与前端 CollabEditor.vue 里的 MermaidBlock 同名同构）。
 *
 * 这里不能用 Vue NodeView（Node 环境没有 Vue），所以 renderHTML 直接产出
 * `<div class="mermaid">`，由前端 MermaidBlock 的 parseHTML 规则（tag: 'div.mermaid'）
 * 识别并接管渲染。属性名 code 与前端一致，parseHTML 从 textContent 取源码。
 *
 * 关键：group 设为 'block'、atom、draggable，避免变成可编辑文本节点；
 * priority 高于 StarterKit 的 codeBlock，保证 ```mermaid 的 <pre><code class="language-mermaid">
 * 命中本节点而非 CodeBlock。
 */
import { Node, mergeAttributes } from '@tiptap/core'

export const MermaidBlock = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  priority: 101,

  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (el) => {
          const code = el.querySelector('code')
          return code ? (code.textContent || '').replace(/^\n+|\n+$/g, '') : ''
        },
        renderHTML: (attrs) => ({ 'data-code': attrs.code || '' }),
      },
    }
  },

  parseHTML() {
    return [
      { tag: 'div.mermaid' },
      {
        tag: 'pre',
        getAttrs: (el) => {
          const code = el.querySelector('code')
          const m = code?.className?.match(/language-(\w+)/)
          return m && m[1] === 'mermaid' ? {} : false
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    const code = node.attrs.code || ''
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'mermaid' }),
      code,
    ]
  },
})

export default MermaidBlock
