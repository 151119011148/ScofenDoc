<script setup lang="ts">
/**
 * 文章大纲「层级提升/降低」的本地冒烟页。
 * 只被 Vite dev 服务加载（构建只认 index.html），不进生产产物、不连协同服务。
 * 验收脚本：tools/verify-browser/outline-levels-check.mjs
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import HeadingNumber from './extensions/HeadingNumber'
import OutlinePanel from './components/OutlinePanel.vue'

const editor = shallowRef<Editor | null>(null)
const scroller = ref<HTMLElement | null>(null)
const refresh = ref(0)
let mo: MutationObserver | null = null

const filler = '<p>正文填充段落，用来让滚动容器真的能滚动，便于验证跳转与高亮。</p>'.repeat(6)

onMounted(() => {
  const instance = new Editor({
    extensions: [StarterKit, HeadingNumber],
    content: `
      <h1>第一章 总览</h1>
      <p>开篇说明。</p>
      <h2>小节 A</h2>
      ${filler}
      <h3>细节 a1</h3>
      <p>a1 的正文。</p>
      <h2>小节 B</h2>
      ${filler}
      <h3>细节 b1</h3>
      <p>b1 的正文。</p>
      <h4>更深一层</h4>
      <p>h4 不在大纲里，用来验证边界不会越界。</p>
    `,
  })
  editor.value = instance
  ;(window as unknown as { ed: Editor }).ed = instance

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
