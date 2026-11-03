import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * 标题折叠：hover 标题显示三角标识，点击折叠/展开该标题到下一个同级或更高级标题之间的内容。
 *
 * - 通过 addGlobalAttributes 给 heading 增加 fold 属性（存进文档，协同重渲染后不丢失）。
 * - 用 ProseMirror 装饰实现：
 *    * 每个标题前插入一个 inline widget（三角），hover 标题时显示，点击切换 fold。
 *    * 折叠的标题，把其后的同级块（直到下一个 level<=它的标题）加上 fold-hidden 类隐藏。
 *  装饰由文档派生，docChanged 时重建，因此对协同远端更新也稳健。
 */
export const HeadingFold = Extension.create({
  name: 'headingFold',

  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          fold: {
            default: false,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-fold') === '1',
            renderHTML: (attrs: Record<string, any>) =>
              attrs.fold ? { 'data-fold': '1' } : {},
          },
        },
      },
    ]
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const key = new PluginKey('headingFold')

    const build = (doc: PMNode): DecorationSet => {
      const decos: Decoration[] = []
      const folds: { pos: number; level: number; size: number }[] = []

      doc.forEach((node, offset) => {
        if (node.type.name !== 'heading') return
        const level = node.attrs.level as number
        const folded = !!node.attrs.fold

        // 三角 widget：放在标题内容最前（side:-1），hover 标题即可显示
        decos.push(
          Decoration.widget(
            offset + 1,
            () => {
              const span = document.createElement('span')
              span.className = 'fold-caret'
              span.setAttribute('contenteditable', 'false')
              span.textContent = folded ? '▾' : '▸'
              span.addEventListener('mousedown', (e) => {
                e.preventDefault()
                e.stopPropagation()
                const view = editor.view
                const tr = view.state.tr
                tr.setNodeMarkup(offset, undefined, { ...node.attrs, fold: !folded })
                view.dispatch(tr)
              })
              return span
            },
            { side: -1, key: 'fc-' + offset + '-' + (folded ? 1 : 0) },
          ),
        )

        if (folded) folds.push({ pos: offset, level, size: node.nodeSize })
      })

      // 折叠标题：隐藏其后内容，直到下一个 level<=它的标题（或文档末尾）
      for (const f of folds) {
        let scan = f.pos + f.size
        while (scan < doc.content.size) {
          const n = doc.nodeAt(scan)
          if (!n) break
          const start = scan
          const end = scan + n.nodeSize
          if (n.type.name === 'heading' && (n.attrs.level as number) <= f.level) break
          decos.push(Decoration.node(start, end, { class: 'fold-hidden' }))
          scan = end
        }
      }

      return DecorationSet.create(doc, decos)
    }

    return [
      new Plugin({
        key,
        state: {
          init: (_cfg, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state) as DecorationSet,
        },
      }),
    ]
  },
})

export default HeadingFold
