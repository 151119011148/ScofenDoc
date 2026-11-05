<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import HeadingNumber from './extensions/HeadingNumber'
import HeadingFold from './extensions/HeadingFold'
import ListItemHeading from './extensions/ListItemHeading'
import TableTools from './components/TableTools.vue'

const editor = ref<Editor>()
let instance: Editor | null = null

onMounted(() => {
  instance = new Editor({
    extensions: [
      StarterKit.configure({ history: false, listItem: false }),
      ListItemHeading,
      HeadingFold,
      HeadingNumber,
      // 与生产一致：列宽可拖、块手柄可选中整表
      Table.configure({
        resizable: true,
        lastColumnResizable: true,
        allowTableNodeSelection: true,
        handleWidth: 6,
      }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: `
      <h1>第一章</h1><h2>小节 A</h2><h2>小节 B</h2><h3>细项</h3><p>正文一段</p>
      <table><tbody>
        <tr><th>A</th><th>B</th><th>C</th></tr>
        <tr><td>1</td><td>2</td><td>3</td></tr>
        <tr><td>4</td><td>5</td><td>6</td></tr>
      </tbody></table>`,
  })
  editor.value = instance
  ;(window as unknown as { ed: Editor }).ed = instance
})

onBeforeUnmount(() => instance?.destroy())
</script>

<template>
  <div style="max-width: 820px; margin: 0 auto; padding: 32px 48px; background: #fff">
    <EditorContent :editor="editor" />
    <TableTools v-if="editor" :editor="editor" :editable="true" />
  </div>
</template>
