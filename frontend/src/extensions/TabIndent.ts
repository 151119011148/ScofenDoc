import { Extension } from '@tiptap/core'
import type { ResolvedPos } from '@tiptap/pm/model'

/**
 * 正文里按 Tab 空两个字符（中文写作的「首行缩进两格」）。
 *
 * 为什么是实体字符而不是 CSS text-indent：
 *   - 缩进要跟着 Yjs 协同、复制粘贴、HTML 导出一起走，节点属性方案在这些路径上会丢；
 *   - 用两个全角空格 U+3000，宽度正好等于两个汉字，且不属于 HTML 可折叠空白，
 *     在 white-space: pre-wrap / normal 下都不会被浏览器压成一个。
 *
 * 只接管「普通文本块」的 Tab。列表层级缩进（sinkListItem）、表格跳格
 * （goToNextCell）、斜杠菜单确认（editorProps.handleKeyDown）都比它先注册/先执行，
 * 这里再显式让路一次，避免扩展顺序变动后把原有行为吃掉。
 *
 * Shift+Tab 是反向操作：光标前刚好是刚插入的两格就删掉，否则交给列表提升等命令。
 */

/** 两个全角空格＝两个中文字符宽 */
const INDENT = '\u3000\u3000'
/** 代码块保持等宽习惯，用两个半角空格 */
const CODE_INDENT = '  '

const LIST_TYPES = new Set(['listItem', 'taskItem', 'bulletList', 'orderedList', 'taskList'])
const TABLE_TYPES = new Set(['table', 'tableRow', 'tableCell', 'tableHeader'])

function isListOrTable($from: ResolvedPos): boolean {
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (LIST_TYPES.has(name) || TABLE_TYPES.has(name)) return true
  }
  return false
}

export const TabIndent = Extension.create({
  name: 'tabIndent',

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        const { selection } = editor.state
        if (!selection.empty || isListOrTable(selection.$from)) return false
        const parent = selection.$from.parent
        if (!parent.isTextblock) return false
        return editor.commands.insertContent(
          parent.type.name === 'codeBlock' ? CODE_INDENT : INDENT,
        )
      },

      'Shift-Tab': ({ editor }) => {
        const { selection } = editor.state
        if (!selection.empty || isListOrTable(selection.$from)) return false
        const $from = selection.$from
        const parent = $from.parent
        if (!parent.isTextblock) return false

        const unit = parent.type.name === 'codeBlock' ? CODE_INDENT : INDENT
        const before = parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
        if (!before.endsWith(unit)) return false
        return editor.commands.deleteRange({ from: $from.pos - unit.length, to: $from.pos })
      },
    }
  },
})

export default TabIndent
