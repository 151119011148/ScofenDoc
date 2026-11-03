import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import MermaidView from '../components/MermaidView.vue'

/**
 * Mermaid 图块：把 ```mermaid 围栏（或 <div class="mermaid">）渲染成真正的图。
 *
 * - group: block / atom：作为一个整体块，不可编辑内部文本（改源码要走属性）。
 * - 与导入管线 tools/md-to-collab/mermaid-block.mjs 的节点定义保持「同名 + 同属性解析」，
 *   否则导入后客户端 schema 不认，节点会被静默丢弃（README 坑 #1）。
 * - priority 高于 StarterKit 的 CodeBlock，保证 mermaid 的 pre 规则优先命中；
 *   非 mermaid 的 pre 经 getAttrs 返回 false 回退给 CodeBlock。
 */
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
        parseHTML: (el: HTMLElement) => {
          if (el.tagName === 'DIV' && el.classList.contains('mermaid')) {
            return (el.textContent || '').replace(/^\n+|\n+$/g, '')
          }
          const code = el.querySelector('code')
          return code ? (code.textContent || '').replace(/^\n+|\n+$/g, '') : ''
        },
        renderHTML: (attrs: Record<string, any>) => ({ 'data-code': attrs.code || '' }),
      },
    }
  },

  parseHTML() {
    return [
      { tag: 'div.mermaid' },
      {
        tag: 'pre',
        getAttrs: (el: HTMLElement) => {
          const code = el.querySelector('code')
          const m = code?.className?.match(/language-(\w+)/)
          return m && m[1] === 'mermaid' ? {} : false
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'mermaid-block' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(MermaidView)
  },
})

export default MermaidBlock
