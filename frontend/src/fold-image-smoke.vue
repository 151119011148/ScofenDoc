<script setup lang="ts">
/**
 * 临时冒烟页：标题折叠时，小节内的配图（顶层 image 块）是否一起收起来。
 * 只被 Vite dev 加载，验完即删。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import HeadingFold from './extensions/HeadingFold'

const editor = ref<Editor>()
let instance: Editor | null = null

const PNG =
  'data:image/svg+xml;base64,' +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#3370ff"/></svg>')

onMounted(() => {
  instance = new Editor({
    extensions: [
      StarterKit.configure({ history: false }),
      HeadingFold,
      Image.configure({ inline: false, allowBase64: true }),
    ],
    content: `
      <h2>一、需要折叠的小节</h2>
      <p>小节正文第一段。</p>
      <img src="${PNG}" alt="示意图">
      <p>图片后面还有一段。</p>
      <h3>1.1 更深一层</h3>
      <p>子小节正文。</p>
      <img src="${PNG}" alt="子图">
      <h2>二、不该被带走的小节</h2>
      <p>下一节的正文，保持可见。</p>
      <img src="${PNG}" alt="另一节的图">`,
  })
  editor.value = instance
  ;(window as unknown as { ed: Editor }).ed = instance
})

onBeforeUnmount(() => instance?.destroy())
</script>

<template>
  <div style="max-width: 820px; margin: 0 auto; padding: 32px 48px; background: #fff">
    <EditorContent :editor="editor" />
  </div>
</template>
