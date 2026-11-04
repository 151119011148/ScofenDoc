import CodeBlock from '@tiptap/extension-code-block'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import DiagramCodeBlockView from '../components/DiagramCodeBlockView.vue'

/**
 * 代码块 + 「内容能画就画」的 NodeView。
 *
 * 节点名保持 `codeBlock` 不变，schema 与历史数据、导入管线完全一致 ——
 * 只把渲染层换掉，所以已有的普通代码块（哪怕没有 language）刷新后就能出图，
 * 不需要改 Yjs 二进制，也不会让协同两端 schema 打架。
 *
 * 与 MermaidBlock / PlantUMLBlock 的分工：
 * - 那两者是 atom 节点，负责导入管线产出的 `div.mermaid`；
 * - 本扩展负责「用户自己粘贴/输入的 codeBlock」，两者渲染出的图外观统一。
 */
export const DiagramCodeBlock = CodeBlock.extend({
  addNodeView() {
    return VueNodeViewRenderer(DiagramCodeBlockView)
  },
})

export default DiagramCodeBlock
