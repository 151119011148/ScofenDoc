import Table from '@tiptap/extension-table'
import { columnResizing } from '@tiptap/pm/tables'

export default Table.extend({
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? []
    const { resizable, handleWidth, cellMinWidth, View, lastColumnResizable } = this.options
    if (!resizable || this.editor.isEditable) return plugins

    // 协同编辑器先以只读挂载，授权后才可编辑。列宽插件需要在挂载时注册，
    // 它自己的鼠标事件会按当前 view.editable 判断是否允许拖动。
    return [
      columnResizing({ handleWidth, cellMinWidth, defaultCellMinWidth: cellMinWidth, View, lastColumnResizable }),
      ...plugins,
    ]
  },
})
