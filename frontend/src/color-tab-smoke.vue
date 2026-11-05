<script setup lang="ts">
/**
 * 颜色一键上色 / Tab 缩进 / 编号标题 / 有序列表序号 的本地冒烟页。
 * 只被 Vite dev 服务加载（构建只认 index.html），不进生产产物、不连协同服务。
 * 验收脚本：tools/verify-browser/color-tab-check.mjs
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import * as Y from 'yjs'
import HeadingNumber from './extensions/HeadingNumber'
import HeadingFold from './extensions/HeadingFold'
import TabIndent from './extensions/TabIndent'
import SelectionToolbar from './components/SelectionToolbar.vue'

const editor = ref<Editor>()
const ydoc = new Y.Doc()
let instance: Editor | null = null

onMounted(() => {
  instance = new Editor({
    extensions: [
      StarterKit.configure({ history: false }),
      Underline,
      TextStyle,
      Color,
      HeadingNumber,
      HeadingFold,
      TabIndent,
    ],
    content: `
      <h1>第一章</h1>
      <h2>小节 A</h2>
      <p>正文一段，用来测试颜色与 Tab 缩进。</p>
      <p>另一段文字用来验证一键上色</p>
      <ol><li><p>列表项一</p></li><li><p>列表项二</p></li></ol>
      <ul><li><p>无序项</p></li></ul>
      <pre><code>const a = 1</code></pre>
    `,
  })
  editor.value = instance
  ;(window as unknown as { ed: Editor }).ed = instance
})

onBeforeUnmount(() => instance?.destroy())
</script>

<template>
  <div style="max-width: 820px; margin: 0 auto; padding: 32px 48px; background: #fff">
    <EditorContent :editor="editor" />
    <SelectionToolbar v-if="editor" :editor="editor" :ydoc="ydoc" :editable="true" />
  </div>
</template>
