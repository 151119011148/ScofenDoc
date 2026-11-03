<script setup lang="ts">
/**
 * 通用弹窗外壳。
 *
 * 只负责遮罩、居中、标题栏和关闭，业务内容由插槽给——
 * 成员管理、改密、账号管理三个弹窗共用，避免各写一套样式后长歪。
 */
withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    width?: number
  }>(),
  { width: 460 },
)

const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" :style="{ width: width + 'px' }">
      <header class="modal-head">
        <div>
          <h3>{{ title }}</h3>
          <p v-if="subtitle" class="modal-sub">{{ subtitle }}</p>
        </div>
        <button class="modal-x" type="button" @click="emit('close')">✕</button>
      </header>

      <div class="modal-body">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="modal-foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>
