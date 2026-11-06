import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { CellSelection, cellAround } from '@tiptap/pm/tables'

/**
 * 跨单元格拖选时把普通文本选区升级成「单元格选区」。
 *
 * prosemirror-tables 只会把 NodeSelection（整格/整行被选中）归一成 CellSelection，
 * 鼠标从一格拖到另一格得到的仍是 TextSelection —— 长文本的表格里尤其明显，
 * 结果「合并单元格 / 底色 / 对齐」这些操作条永远浮不出来。
 *
 * 这里在 mouseup 时判断：如果选区两端落在不同单元格，就换成 CellSelection
 * （和飞书一致，拖过去整格整格地亮）。放在 mouseup 而不是 mousemove，
 * 是为了不和浏览器原生的拖拽选区抢事件，避免选中过程抖动。
 */
export const CellDragSelect = Extension.create({
  name: 'cellDragSelect',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mouseup: (view) => {
              const { state } = view
              const sel = state.selection
              if (!(sel instanceof TextSelection) || sel.empty) return false
              const from = cellAround(sel.$from)
              const to = cellAround(sel.$to)
              // 同一格内选字不动它；只有跨格才升级
              if (!from || !to || from.pos === to.pos) return false
              try {
                view.dispatch(state.tr.setSelection(CellSelection.create(state.doc, from.pos, to.pos)))
              } catch {
                /* 跨表等异常情况保持原选区 */
              }
              return false
            },
          },
        },
      }),
    ]
  },
})

export default CellDragSelect
