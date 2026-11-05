import ListItem from '@tiptap/extension-list-item'

/**
 * 让标题可以留在有序 / 无序列表项里。
 *
 * StarterKit 内置 ListItem 的 content 是 'paragraph block*'（首子节点必须是
 * paragraph），后果是：在 H1 上点「有序/无序列表」时 ProseMirror 找不到合法的
 * 包装方式，把标题降级成段落；在列表项里设 H1 又会把这一项拆出列表。
 * 改成 '(paragraph | heading) block*' 后首子节点可以是标题，于是同一个块
 * 能同时是 H1 和有序/无序列表项，蓝色 1. / ● 由 ::marker 提供。
 *
 * 兼容性：旧文档里 listItem 的首子节点都是 paragraph，仍然合法；Yjs 协同
 * 只同步 CRDT 结构、不解析 schema，服务端无需改动。需要保证同一文档的所有
 * 客户端加载同一份前端代码 —— 发布后已打开的编辑页刷新一次即可。
 */
export const ListItemHeading = ListItem.extend({
  content: '(paragraph | heading) block*',
})

export default ListItemHeading
