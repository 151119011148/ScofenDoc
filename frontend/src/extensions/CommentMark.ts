import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * 批注/评论标记。
 *
 * 只在正文里留一个「锚点」：mark 上存 id（和是否已解决），
 * 真正的评论正文、回复、作者、时间都放在 ydoc 的 comments 这个 Y.Map 里。
 *
 * 为什么不把评论内容塞进 mark 属性：
 * - 一条评论会回复很多次，改正文属性等于重切整段 mark，协同时会产生大量无意义操作；
 * - 评论正文可能几百字，塞进每个文本节点的 attrs 会把正文撑得很大。
 * Y.Map 随同一个 ydoc 同步/落盘（collab/server.js 存的是全量 update），不需要改后端。
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentMark: {
      /** 给当前选区打上批注锚点 */
      setComment: (id: string) => ReturnType
      /** 去掉当前选区的批注锚点 */
      unsetComment: () => ReturnType
    }
  }
}

export const CommentMark = Mark.create({
  name: 'comment',

  // 在批注末尾继续输入不应该自动带批注；中间切开则各自保留
  inclusive: false,
  keepOnSplit: false,
  // 可以和粗体/斜体等共存
  excludes: '',

  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-comment-id') || '',
        renderHTML: (attrs: Record<string, any>) =>
          attrs.id ? { 'data-comment-id': attrs.id } : {},
      },
      resolved: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-resolved') === '1',
        renderHTML: (attrs: Record<string, any>) =>
          attrs.resolved ? { 'data-resolved': '1' } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'mark[data-comment-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes({ class: 'cmt-mark' }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setComment:
        (id: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { id, resolved: false }),
      unsetComment:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})
