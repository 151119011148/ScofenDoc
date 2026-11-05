import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * 标题自动编号：让同一个块既是标题、又带「有序」编号（飞书式 1 / 1.1 / 1.1.1）。
 *
 * 为什么不复用 orderedList：
 *   heading 和 listItem 在 ProseMirror schema 里是互斥的块类型，toggleOrderedList
 *   会把标题降级成普通段落。这里给 heading 加一个 numbered 属性（存进文档、随 Yjs 同步），
 *   序号本身不落库、由装饰派生 —— 中间插入/删除标题时后面所有编号自动跟着变，
 *   协同两端算出来的结果也永远一致。
 *
 * 计数规则：
 *   只为「开启编号」的标题占号：遇到 N 级标题，N 级 +1、N 级以下清零，
 *   再把 1..N 级拼起来。没开编号的标题既不占号也不重置计数，
 *   于是关掉中间某个标题后，后面的编号会顺次补位（1.2 → 1.1）。
 *   上级没有编号时省略前导 0：一级无号、二级有号显示「1.」而不是「0.1.」。
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    headingNumber: {
      /** 切换选区内标题的编号；没有标题时把当前块转成二级编号标题 */
      toggleHeadingNumber: (value?: boolean) => ReturnType
      /** 全文一键开关：适合长文档统一加章节号 */
      setAllHeadingsNumbered: (value: boolean) => ReturnType
    }
  }
}

const key = new PluginKey<DecorationSet>('headingNumber')

/** 从文档算出每个编号标题的序号，写成 node 装饰的 data-number，CSS 用 ::before 显示 */
function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  const nums = [0, 0, 0, 0, 0, 0]

  // 与大纲面板保持同一口径：只认顶层标题，嵌套在引用/列表里的标题不参与编号
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading' || !node.attrs.numbered) return
    const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1))

    nums[level - 1] += 1
    for (let i = level; i < nums.length; i++) nums[i] = 0

    // 上级没有编号时不要显示成 "0.1"：从第一个非零层级开始拼
    const parts: number[] = []
    let started = false
    for (let i = 0; i < level; i++) {
      if (nums[i] > 0) started = true
      if (started) parts.push(nums[i])
    }
    const label = (parts.join('.') || '1') + '.'

    // 只用 data-number：节点自身已经会渲染 data-numbered，
    // 装饰再写同名属性会跟 ProseMirror 的 DOM patch 打架（关掉编号时残留属性）
    decos.push(Decoration.node(offset, offset + node.nodeSize, { 'data-number': label }))
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
        },
      },
    ]
  },

  addCommands() {
    return {
      toggleHeadingNumber:
        (value?: boolean) =>
        ({ tr, dispatch, commands }) => {
          const headingType = tr.doc.type.schema.nodes.heading
          if (!headingType) return false

          // 注意用 tr.doc / tr.selection：斜杠菜单是「先删除 /xxx 再执行命令」的 chain，
          // 此时 state 还是删除前的旧文档，拿旧位置会写错节点。
          const { from, to, $from } = tr.selection
          const hits: { pos: number; node: PMNode }[] = []
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type === headingType) hits.push({ pos, node })
            return true
          })

          const next = value ?? !(hits.length > 0 && hits.every((h) => !!h.node.attrs.numbered))
          if (!dispatch) return true

          if (hits.length) {
            for (const h of hits) {
              tr.setNodeMarkup(tr.mapping.map(h.pos), undefined, {
                ...h.node.attrs,
                numbered: next,
              })
            }
          } else if (next) {
            // 光标在列表项里时，listItem 的首子节点必须是 paragraph：直接在里面
            // 换成 heading 会被 ProseMirror 判为非法结构并整块拆出去，命令返回 true
            // 却什么都没发生（用户点「编号标题」没反应就是这里）。
            // 所以先把这一项提升成顶层文本块，再转成带编号的标题。
            const listItemType = tr.doc.type.schema.nodes.listItem
            let inListItem = false
            if (listItemType) {
              for (let d = $from.depth - 1; d > 0; d--) {
                if ($from.node(d).type === listItemType) {
                  inListItem = true
                  break
                }
              }
            }
            if (inListItem) commands.liftListItem(listItemType)

            // lift 之后选区位置会变，必须重新从 tr 取，不能沿用上面的旧 $from
            const $at = tr.selection.$from
            const d = $at.depth
            if (d > 0 && $at.parent.isTextblock) {
              tr.setBlockType($at.before(d), $at.after(d), headingType, {
                ...$at.parent.attrs,
                level: 2,
                numbered: true,
              })
            } else {
              return false
            }
          }
          return true
        },

      setAllHeadingsNumbered:
        (value: boolean) =>
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
          for (const h of hits) {
            tr.setNodeMarkup(tr.mapping.map(h.pos), undefined, {
              ...h.node.attrs,
              numbered: value,
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
