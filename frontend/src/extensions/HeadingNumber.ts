import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * 标题前缀：让同一个块既是标题、又带前缀（1 / 1.1 / 1.1.1，或 ● ○ ■ □ ◆ ◇）。
 *
 * 为什么不复用 orderedList：
 *   heading 和 listItem 在默认 ProseMirror schema 里互斥（ListItem 首子必须是
 *   paragraph，点有序列表会把标题降级）。项目里用 ListItemHeading 放宽了这个
 *   限制，让 H1 能真正留在 ol/ul 里；这里则给**独立标题**加前缀 —— 两条路径
 *   都能让「标题 + 有序/无序」同时存在。前缀本身不落库、由装饰派生，中间
 *   插入/删除标题时后面所有编号自动跟着变，协同两端算出来的结果也永远一致。
 *
 * 两种前缀：
 *   ordered   按层级计数，1 / 1.1 / 1.1.1 ... 最深 6 段（H6 → 1.1.1.1.1.1）。
 *   unordered 不计数，按标题层级取固定符号 ● ○ ■ □ ◆ ◇，同样 6 级。
 *
 * 计数规则：
 *   只为「开启编号」的标题占号：遇到 N 级标题，N 级 +1、N 级以下清零，
 *   再把 1..N 级拼起来。没开编号的标题既不占号也不重置计数，
 *   于是关掉中间某个标题后，后面的编号会顺次补位（1.2 → 1.1）。
 *   上级没有编号时省略前导 0：一级无号、二级有号显示「1.」而不是「0.1.」。
 */
export type HeadingNumberStyle = 'ordered' | 'unordered'

/** 无序标题的层级符号，索引 0 对应 H1 */
export const UNORDERED_SIGNS = ['●', '○', '■', '□', '◆', '◇'] as const

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    headingNumber: {
      /**
       * 切换选区内标题的前缀；没有标题时把当前块转成一级编号标题（H1）。
       * style 只在开启时写入，省略则沿用标题原有样式（旧文档默认有序）。
       */
      toggleHeadingNumber: (value?: boolean, style?: HeadingNumberStyle) => ReturnType
      /** 全文一键开关：适合长文档统一加章节号 / 统一换成无序符号 */
      setAllHeadingsNumbered: (value: boolean, style?: HeadingNumberStyle) => ReturnType
    }
  }
}

const key = new PluginKey<DecorationSet>('headingNumber')

/** 从文档算出每个编号标题的前缀，写成 node 装饰的 data-number，CSS 用 ::before 显示 */
function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  const nums = [0, 0, 0, 0, 0, 0]

  // 与大纲面板保持同一口径：只认顶层标题，嵌套在引用/列表里的标题不参与编号
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading' || !node.attrs.numbered) return
    const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1))
    const style: HeadingNumberStyle =
      node.attrs.numberStyle === 'unordered' ? 'unordered' : 'ordered'

    nums[level - 1] += 1
    for (let i = level; i < nums.length; i++) nums[i] = 0

    let label: string
    if (style === 'unordered') {
      // 符号只由层级决定，不参与计数；H1..H6 刚好六个，超过 6 级 clamp 到 6
      label = UNORDERED_SIGNS[level - 1]
    } else {
      // 上级没有编号时不要显示成 "0.1"：从第一个非零层级开始拼
      const parts: number[] = []
      let started = false
      for (let i = 0; i < level; i++) {
        if (nums[i] > 0) started = true
        if (started) parts.push(nums[i])
      }
      label = (parts.join('.') || '1') + '.'
    }

    // 节点自身渲染的是 data-numbered / data-numbered-style，装饰必须用不同的属性名：
    // 同名属性会跟 ProseMirror 的 DOM patch 打架（关掉编号时残留属性）。
    decos.push(
      Decoration.node(offset, offset + node.nodeSize, {
        'data-number': label,
        'data-number-kind': style,
        'data-number-level': String(level),
      }),
    )
  })

  return DecorationSet.create(doc, decos)
}

export const HeadingNumber = Extension.create({
  name: 'headingNumber',

  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          numbered: {
            default: false,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-numbered') === '1',
            renderHTML: (attrs: Record<string, any>) =>
              attrs.numbered ? { 'data-numbered': '1' } : {},
          },
          numberStyle: {
            default: 'ordered' as HeadingNumberStyle,
            parseHTML: (el: HTMLElement): HeadingNumberStyle =>
              el.getAttribute('data-numbered-style') === 'unordered' ? 'unordered' : 'ordered',
            // 只给无序写标记：有序是默认值，不写更干净，也不与装饰属性同名
            renderHTML: (attrs: Record<string, any>) =>
              attrs.numbered && attrs.numberStyle === 'unordered'
                ? { 'data-numbered-style': 'unordered' }
                : {},
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      toggleHeadingNumber:
        (value?: boolean, style?: HeadingNumberStyle) =>
        ({ tr, dispatch }) => {
          const headingType = tr.doc.type.schema.nodes.heading
          if (!headingType) return false

          // 注意用 tr.doc / tr.selection：斜杠菜单是「先删除 /xxx 再执行命令」的 chain，
          // 此时 state 还是删除前的旧文档，拿旧位置会写错节点。
          const { from, to } = tr.selection
          const hits: { pos: number; node: PMNode }[] = []
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type === headingType) hits.push({ pos, node })
            return true
          })

          const next = value ?? !(hits.length > 0 && hits.every((h) => !!h.node.attrs.numbered))
          if (!dispatch) return true

          // 不传 style 时只切开关，保留每个标题原有的样式
          const styleAttrs = style ? { numberStyle: style } : {}

          if (hits.length) {
            for (const h of hits) {
              tr.setNodeMarkup(tr.mapping.map(h.pos), undefined, {
                ...h.node.attrs,
                numbered: next,
                ...styleAttrs,
              })
            }
          } else if (next) {
            // 光标在普通段落里点「有序/无序标题」：直接升成 H1 并带前缀，
            // 不再默认 H2 —— 用户要的是 H1 与有序/无序同时存在，先转成 H2
            // 再手动改级别这一步会「看起来没生效」。已有标题则走上面的 hits
            // 分支，一律保留原 level。
            //
            // 如果这一段在 listItem 里也不 lift：ListItemHeading 已放宽 content，
            // 就地换成 heading 能保住列表归属，蓝色 1. / ● 由 ::marker 提供，
            // 不会和标题前缀重复（build() 只给顶层标题派生前缀）。
            const $at = tr.selection.$from
            const d = $at.depth
            if (d > 0 && $at.parent.isTextblock) {
              tr.setBlockType($at.before(d), $at.after(d), headingType, {
                ...$at.parent.attrs,
                level: 1,
                numbered: true,
                numberStyle: style ?? 'ordered',
              })
            } else {
              return false
            }
          }

          // 若这个标题落在列表项里，按所选样式同步列表类型：点「无序标题」不该
          // 还留着 ol 的数字。只切换最内层所在的那个列表，嵌套外层不动。
          if (style) {
            const targetList =
              style === 'unordered'
                ? tr.doc.type.schema.nodes.bulletList
                : tr.doc.type.schema.nodes.orderedList
            const $p = tr.selection.$from
            if (targetList) {
              for (let depth = $p.depth - 1; depth > 0; depth--) {
                const n = $p.node(depth)
                if (n.type.name !== 'orderedList' && n.type.name !== 'bulletList') continue
                if (n.type !== targetList) {
                  tr.setNodeMarkup(tr.mapping.map($p.before(depth)), targetList, { start: 1 })
                }
                break
              }
            }
          }
          return true
        },

      setAllHeadingsNumbered:
        (value: boolean, style?: HeadingNumberStyle) =>
        ({ tr, dispatch }) => {
          const headingType = tr.doc.type.schema.nodes.heading
          if (!headingType) return false
          const hits: { pos: number; node: PMNode }[] = []
          // 与 build() 同口径只处理顶层：嵌套在引用/列表里的标题不参与编号，
          // 给它加属性反而会出现「有 data-numbered 却看不到序号」的怪现象
          tr.doc.forEach((node, offset) => {
            if (node.type === headingType) hits.push({ pos: offset, node })
          })
          if (!dispatch) return hits.length > 0
          const styleAttrs = style ? { numberStyle: style } : {}
          for (const h of hits) {
            tr.setNodeMarkup(tr.mapping.map(h.pos), undefined, {
              ...h.node.attrs,
              numbered: value,
              ...styleAttrs,
            })
          }
          return true
        },
    }
  },

  addProseMirrorPlugins() {
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

export default HeadingNumber
