<template>
  <div 
    class="drop-zone"
    :class="{ 'drop-zone--active': isDragging }"
    @click="openFileDialog"
    @keydown.enter.prevent="openFileDialog"
    @keydown.space.prevent="openFileDialog"
    @dragover.prevent="isDragging = true"
    @dragenter.prevent="isDragging = true"
    @dragleave="isDragging = false"
    @drop.prevent="handleDrop"
    role="button"
    tabindex="0"
  >
    <div class="drop-zone__icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    </div>
    <div class="drop-zone__title">拖拽照片到这里</div>
    <div class="drop-zone__hint">或点击选择文件</div>
    <input 
      ref="fileInput"
      type="file" 
      multiple 
      accept="image/jpeg,image/png,image/webp,image/gif"
      @click.stop
      @change="handleFileSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  files: [files: File[]]
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)

function openFileDialog() {
  const el = fileInput.value
  if (!el) return
  // Reset BEFORE opening to ensure change event always fires (including re-selecting the same file).
  el.value = ''
  el.click()
}

function handleFileSelect(e: Event) {
  const input = e.currentTarget as HTMLInputElement
  if (input.files && input.files.length > 0) {
    emit('files', Array.from(input.files))
    input.value = '' // 重置以允许重新选择相同文件
  }
}

function handleDrop(e: DragEvent) {
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    emit('files', Array.from(files))
  }
}
</script>
