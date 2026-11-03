import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import PlantUMLView from '../components/PlantUMLView.vue'

/**
 * PlantUML 图块：把 ```plantuml / ```puml / ```uml 围栏（或 <div class="plantuml">）
 * 渲染成真正的图（时序图/类图/用例图等）。
 *
 * 与 MermaidBlock 并列，独立成一个节点类型（name: 'plantuml'），
 * 这样两种图各自解析、各自渲染，互不干扰，也便于后续单独扩展图类型。
 *
 * - group: block / atom：整体块，不可编辑内部文本（改源码走属性）。
 * - 与导入管线 tools/md-to-collab/plantuml-block.mjs 保持「同名 + 同属性解析」，
 *   否则导入后客户端 schema 不认，节点会被静默丢弃（README 坑 #1）。
 * - priority 高于 StarterKit 的 CodeBlock，保证 plantuml 的 pre 规则优先命中；
 *   非 plantuml 的 pre 经 getAttrs 返回 false 回退给 CodeBlock。
 */
export const PlantUMLBlock = Node.create({
  name: 'plantuml',
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
          if (el.tagName === 'DIV' && el.classList.contains('plantuml')) {
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
      { tag: 'div.plantuml' },
      {
        tag: 'pre',
        getAttrs: (el: HTMLElement) => {
          const code = el.querySelector('code')
          const m = code?.className?.match(/language-(\w+)/)
          // 认 plantuml / puml / uml 三种围栏别名
          return m && ['plantuml', 'puml', 'uml'].includes(m[1].toLowerCase()) ? {} : false
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'plantuml-block' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(PlantUMLView)
  },
})

export default PlantUMLBlock
