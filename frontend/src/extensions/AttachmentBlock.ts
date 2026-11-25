import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import AttachmentView from '../components/AttachmentView.vue'

/**
 * 附件块：正文里显示为一张文件卡片，点击下载。
 *
 * - 只存元数据（id / name / size），不存文件字节 —— 字节在服务器独立目录，
 *   下载走带鉴权的 /api/attachments/{id}/download。
 * - group:block + atom：作为整体块，内部不可编辑，符合「附件不是文本」的语义。
 * - parseHTML/renderHTML 用 data-* 属性，保证 Yjs 往返和协同同步不丢属性。
 */
export const AttachmentBlock = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  priority: 101,

  addAttributes() {
    return {
      id: {
        default: 0,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-id') || 0),
        renderHTML: (attrs: Record<string, any>) => ({ 'data-id': attrs.id || 0 }),
      },
      name: {
        default: '附件',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-name') || '附件',
        renderHTML: (attrs: Record<string, any>) => ({ 'data-name': attrs.name || '附件' }),
      },
      size: {
        default: 0,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-size') || 0),
        renderHTML: (attrs: Record<string, any>) => ({ 'data-size': attrs.size || 0 }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-attachment]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-attachment': '', class: 'attachment-block' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(AttachmentView)
  },
})

export default AttachmentBlock
