<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import FindReplacePanel from './components/FindReplacePanel.vue'

const editor = ref<Editor>()
const open = ref(true)
let instance: Editor | null = null

onMounted(() => {
  instance = new Editor({
    extensions: [StarterKit],
    content: `
      <p>Java 集合框架里最关键的是 List 与 Map。</p>
      <p>list 与 LIST 大小写不同，用于验证「区分大小写」。</p>
      <p>跨<b>块</b>的匹配不应该成立：Java<b>集合</b>框架。</p>
      <p>末尾再来一个 Java，方便统计 4 处。</p>`,
  })
  editor.value = instance
  ;(window as unknown as { ed: Editor }).ed = instance
  ;(window as unknown as { openPanel: () => void }).openPanel = () => {
    open.value = true
  }
})

onBeforeUnmount(() => instance?.destroy())
</script>

<template>
  <div class="find-smoke">
    <EditorContent :editor="editor" />
    <FindReplacePanel v-if="editor && open" :editor="editor" @close="open = false" />
  </div>
</template>

<style>
.find-smoke {
  max-width: 820px;
  margin: 0 auto;
  padding: 32px 48px 240px;
  background: #fff;
}
</style>
