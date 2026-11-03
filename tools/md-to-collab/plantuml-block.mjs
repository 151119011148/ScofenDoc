/**
 * PlantUML 节点定义（导入管线专用，与前端 CollabEditor.vue 里的 PlantUMLBlock 同名同构）。
 *
 * 这里不能用 Vue NodeView（Node 环境没有 Vue），所以 renderHTML 直接产出
 * `<div class="plantuml">`，由前端 PlantUMLBlock 的 parseHTML 规则（tag: 'div.plantuml'）
 * 识别并接管渲染。属性名 code 与前端一致，parseHTML 从 textContent 取源码。
 *
 * 关键：group 设为 'block'、atom、draggable，避免变成可编辑文本节点；
 * priority 高于 StarterKit 的 codeBlock，保证 ```plantuml / ```puml / ```uml 的
 * <pre><code class="language-plantuml"> 命中本节点而非 CodeBlock。
 */
import { Node, mergeAttributes } from '@tiptap/core'

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
      { tag: 'div.plantuml' },
      {
        tag: 'pre',
        getAttrs: (el) => {
          const code = el.querySelector('code')
          const m = code?.className?.match(/language-(\w+)/)
          return m && ['plantuml', 'puml', 'uml'].includes(m[1].toLowerCase()) ? {} : false
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    const code = node.attrs.code || ''
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'plantuml' }),
      code,
    ]
  },
})

export default PlantUMLBlock
