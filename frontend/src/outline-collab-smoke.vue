<script setup lang="ts">
/**
 * 文章大纲「级联升降级 + 撤销重做」的本地冒烟页（协同栈版）。
 *
 * 和 outline-smoke.vue 的区别：这里用真的 Yjs + Collaboration，撤销走 UndoManager，
 * 与线上 CollabEditor 一致——历史栈的实现不同，撤销行为必须在这套栈上验。
 * 只被 Vite dev 服务加载，不进生产产物、不连协同服务。
 *
 * 验收脚本：tools/verify-browser/outline-cascade-check.mjs
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import HeadingNumber from './extensions/HeadingNumber'
import OutlinePanel from './components/OutlinePanel.vue'

const editor = shallowRef<Editor | null>(null)
const scroller = ref<HTMLElement | null>(null)
const refresh = ref(0)
let mo: MutationObserver | null = null

const ydoc = new Y.Doc()

/**
 * 直接往 Y.Doc 里拼初始内容。
 *
 * 不能给 Collaboration 传 content（会被忽略），也不能先建编辑器再 setContent：
 * 那样初始内容会进撤销栈，「撤到底」就不是文档原始状态了。
 * 这里在编辑器创建前写入，撤销栈从空白开始，与线上打开已有文档一致。
 */
function heading(level: number, text: string) {
  const el = new Y.XmlElement('heading')
  // 必须存数字：Tiptap 的 Heading 用 levels.includes(node.attrs.level) 判断，
  // 存成字符串 "2" 会判定失败、一律渲染成 h1（Yjs 按原类型存，不做字符串化）
  el.setAttribute('level', level as unknown as string)
  el.insert(0, [new Y.XmlText(text)])
  return el
}
function para(text: string) {
  const el = new Y.XmlElement('paragraph')
  el.insert(0, [new Y.XmlText(text)])
  return el
}

function seed() {
  const frag = ydoc.getXmlFragment('default')
  ydoc.transact(() => {
    frag.insert(0, [
      heading(1, '第一章 总览'),
      para('开篇说明。'),
      heading(2, '小节 A'),
      heading(3, '细节 a1'),
      para('a1 的正文。'),
      heading(3, '细节 a2'),
      para('a2 的正文。'),
      heading(2, '小节 B'),
      heading(3, '细节 b1'),
      para('b1 的正文。'),
      heading(2, '小节 C'),
      para('C 的正文，用来验证同级不会被前面的级联带走。'),
    ])
  })
}

onMounted(() => {
  seed()

  const instance = new Editor({
    extensions: [StarterKit.configure({ history: false }), Collaboration.configure({ document: ydoc }), HeadingNumber],
    editorProps: { attributes: { class: 'tiptap-smoke' } },
  })
  editor.value = instance
  ;(window as unknown as { ed: Editor; y: Y.Doc }).ed = instance
  ;(window as unknown as { ed: Editor; y: Y.Doc }).y = ydoc

  mo = new MutationObserver(() => refresh.value++)
  mo.observe(instance.view.dom, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-number', 'data-fold', 'data-numbered'],
  })
})

onBeforeUnmount(() => {
  mo?.disconnect()
  editor.value?.destroy()
})
</script>

<template>
  <div style="display: flex; height: 100vh">
    <aside class="outline-col" style="width: 280px">
      <div class="outline-col-head">
        <span class="outline-col-title">文章大纲</span>
      </div>
      <OutlinePanel :scroller="scroller" :editor="editor" :refresh="refresh" />
    </aside>
    <main ref="scroller" class="main" style="flex: 1; overflow-y: auto">
      <EditorContent :editor="editor ?? undefined" />
    </main>
  </div>
</template>
