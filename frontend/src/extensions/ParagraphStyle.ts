import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * 段落级排版：对齐 / 行高 / 字号。
 *
 * 为什么自己写而不用 @tiptap/extension-text-align：
 *  - 项目里本来就没有这些扩展，装三个包只为三行属性，还得同步 5 个冒烟页的扩展清单；
 *  - 用户要的是「选中多行文字一次性统一调格式」，需要的是可以一次遍历选区内
 *    **所有 textblock** 的命令（段落、标题、列表项里的段落、引用里的段落、表格单元格
 *    里的段落都要一起改），官方 textAlign 只认它配置的 types，字号/行高更是没有官方包；
 *  - 属性落 data-* + 行内 style，与 TableCellStyle 的做法一致，协同两端解析规则相同，
 *    存量文档没有这些属性时默认 null，不需要数据迁移。
 *
 * 注意属性挂在「块」上而不是文字 mark 上：跨段落选区时 addMark 只能改文字，
 * 段落对齐/行高/字号必须改节点 attrs，所以命令用 setNodeMarkup 遍历，不是 setMark。
 */

export type ParagraphStyleAttrs = {
  textAlign?: string | null
  lineHeight?: string | null
  fontSize?: string | null
}

const KEYS = ['textAlign', 'lineHeight', 'fontSize'] as const

export const ALIGN_OPTIONS = [
  { label: '左对齐', value: 'left', icon: '☰' },
  { label: '居中', value: 'center', icon: '☷' },
  { label: '右对齐', value: 'right', icon: '☲' },
  { label: '两端对齐', value: 'justify', icon: '☴' },
] as const

export const LINE_HEIGHT_OPTIONS = [
  { label: '紧凑', value: '1.5' },
  { label: '标准', value: '1.8' },
  { label: '宽松', value: '2' },
  { label: '很松', value: '2.5' },
] as const

export const FONT_SIZE_OPTIONS = [
  { label: '小', value: '13' },
  { label: '标准', value: '15.5' },
  { label: '大', value: '18' },
  { label: '特大', value: '22' },
] as const

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphStyle: {
      /** 对选区内所有段落统一设置（只传要改的键，其余保持原样） */
      setParagraphStyle: (attrs: ParagraphStyleAttrs) => ReturnType
      /** 清除段落级排版；不传键则三个全清 */
      unsetParagraphStyle: (keys?: readonly (typeof KEYS)[number][]) => ReturnType
    }
  }
}

/** 收集选区覆盖到的所有 textblock；空选区时取光标所在的那个块 */
function textblocks(state: { doc: PMNode; selection: any }): { pos: number; node: PMNode }[] {
  const { from, to, empty, $from } = state.selection
  const blocks: { pos: number; node: PMNode }[] = []
  state.doc.nodesBetween(from, to, (node: PMNode, pos: number) => {
    if (node.isTextblock) blocks.push({ pos, node })
  })
  if (!blocks.length && empty) {
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d)
      if (node.isTextblock) {
        blocks.push({ pos: $from.before(d), node })
        break
      }
    }
  }
  return blocks
}

const definitions = {
  textAlign: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-text-align') || el.style.textAlign || null,
    renderHTML: (attrs: Record<string, any>) =>
      attrs.textAlign
        ? { 'data-text-align': attrs.textAlign, style: `text-align:${attrs.textAlign}` }
        : {},
  },
  lineHeight: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-line-height') || el.style.lineHeight || null,
    renderHTML: (attrs: Record<string, any>) =>
      attrs.lineHeight
        ? { 'data-line-height': attrs.lineHeight, style: `line-height:${attrs.lineHeight}` }
        : {},
  },
  fontSize: {
    default: null as string | null,
    // style.fontSize 带单位（"18px"），data-font-size 存的是裸数字，统一去掉 px
    // 否则重新渲染时会拼成 "18pxpx"
    parseHTML: (el: HTMLElement) => {
      const raw = el.getAttribute('data-font-size') || el.style.fontSize || ''
      return raw ? raw.replace(/px\s*$/i, '') || null : null
    },
    renderHTML: (attrs: Record<string, any>) =>
      attrs.fontSize
        ? { 'data-font-size': attrs.fontSize, style: `font-size:${attrs.fontSize}px` }
        : {},
  },
}

export const ParagraphStyle = Extension.create({
  name: 'paragraphStyle',

  addGlobalAttributes() {
    return [
      {
        // 列表项 / 引用 / 表格单元格里同样是段落，一起登记，跨行选区才不会漏
        types: ['paragraph', 'heading'],
        attributes: definitions,
      },
    ]
  },

  addCommands() {
    const apply = (
      state: any,
      tr: any,
      dispatch: ((t: any) => void) | undefined,
      patch: (attrs: Record<string, any>, node: PMNode) => boolean,
    ): boolean => {
      const blocks = textblocks(state)
      let changed = false
      for (const { pos, node } of blocks) {
        const next = { ...node.attrs }
        if (!patch(next, node)) continue
        if (dispatch) tr.setNodeMarkup(pos, undefined, next)
        changed = true
      }
      // setNodeMarkup 不动位置，选区保持原样：连续调几次格式不用来回重选
      if (dispatch && changed) tr.scrollIntoView()
      return changed
    }

    return {
      setParagraphStyle:
        (attrs) =>
        ({ state, tr, dispatch }) =>
          apply(state, tr, dispatch, (next) => {
            let dirty = false
            for (const k of KEYS) {
              const v = attrs[k]
              if (v !== undefined && next[k] !== v) {
                next[k] = v
                dirty = true
              }
            }
            return dirty
          }),

      unsetParagraphStyle:
        (keys) =>
        ({ state, tr, dispatch }) =>
          apply(state, tr, dispatch, (next) => {
            let dirty = false
            for (const k of keys ?? KEYS) {
              if (next[k] !== null && next[k] !== undefined) {
                next[k] = null
                dirty = true
              }
            }
            return dirty
          }),
    }
  },
})
