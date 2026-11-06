import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'

/**
 * 给表格单元格补上飞书的两项基础能力：底色与对齐。
 *
 * prosemirror-tables 的单元格只认 colspan / rowspan / colwidth，没有颜色和对齐；
 * 这里用 addAttributes 挂两个可选属性，值直接落成 `data-bg` / `data-align` 和行内 style：
 *   - 行内 style 负责真实渲染，导出 HTML、复制到其它编辑器也能带着走；
 *   - data-* 负责回读，parseHTML 时优先认它，其次兼容外部 HTML 的 style。
 *
 * 属性默认 null，老文档没有这两个字段时渲染结果与之前完全一致，
 * 所以不需要迁移存量协同数据。
 */

type CellAttrs = Record<string, unknown>

/** 飞书「底色」里最常用的一档浅色，按红橙黄绿蓝紫灰排列 */
export const CELL_BACKGROUNDS = [
  { label: '无', value: null },
  { label: '红', value: '#fde2e2' },
  { label: '橙', value: '#faecd8' },
  { label: '黄', value: '#fdf6d8' },
  { label: '绿', value: '#e3f9e9' },
  { label: '蓝', value: '#e1eaff' },
  { label: '紫', value: '#f0e6ff' },
  { label: '灰', value: '#f2f3f5' },
] as const

export const CELL_ALIGNS = [
  { label: '左对齐', value: 'left' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'right' },
] as const

function styleOf(el: HTMLElement, prop: string): string | null {
  const v = el.style.getPropertyValue(prop)
  return v ? v.trim() : null
}

const background = {
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute('data-bg') || styleOf(el, 'background-color') || null,
  renderHTML: (attrs: CellAttrs) => {
    if (!attrs.background) return {}
    return { 'data-bg': attrs.background, style: `background-color:${attrs.background}` }
  },
}

const align = {
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute('data-align') || styleOf(el, 'text-align') || null,
  renderHTML: (attrs: CellAttrs) => {
    if (!attrs.align) return {}
    return { 'data-align': attrs.align, style: `text-align:${attrs.align}` }
  },
}

/** 编辑器、冒烟页、配色页共用同一份节点定义，避免 schema 不一致导致协同内容被改写 */
export const StyledTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), background, align }
  },
})

export const StyledTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), background, align }
  },
})
