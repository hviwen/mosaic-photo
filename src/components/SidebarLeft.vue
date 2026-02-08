<template>
  <div class="h-100 d-flex flex-column">
    <v-toolbar density="compact" flat>
      <v-avatar size="32" class="mr-2">
        <v-img src="/assets/logo.svg" alt="MosaicPhoto" />
      </v-avatar>
      <v-toolbar-title v-if="!ui.leftSidebarCollapsed">MosaicPhoto</v-toolbar-title>
      <v-spacer />
      <v-btn
        icon
        variant="text"
        :title="ui.leftSidebarCollapsed ? '展开' : '折叠'"
        @click="ui.toggleLeftSidebar()"
      >
        <v-icon :icon="ui.leftSidebarCollapsed ? 'mdi-chevron-right' : 'mdi-chevron-left'" />
      </v-btn>
    </v-toolbar>
    <v-divider />

    <div v-if="ui.leftSidebarCollapsed" class="py-3 px-2 flex-1-1 d-flex flex-column align-center">
      <v-btn
        icon
        variant="text"
        title="上传照片"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-image-multiple" />
      </v-btn>
      <v-btn
        icon
        variant="text"
        title="画布尺寸"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-aspect-ratio" />
      </v-btn>
      <v-btn
        icon
        variant="text"
        title="自动排版"
        :disabled="store.photoCount === 0"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-auto-fix" />
      </v-btn>
      <v-btn
        icon
        variant="text"
        title="导出拼图"
        :disabled="store.photoCount === 0"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-export" />
      </v-btn>

      <v-spacer />

      <v-btn
        icon
        variant="text"
        title="清空"
        :disabled="store.photoCount === 0"
        @click="clearAll"
      >
        <v-icon icon="mdi-delete-sweep" />
      </v-btn>
    </div>

    <div v-else class="pa-4 flex-1-1 overflow-y-auto">
      <v-card variant="tonal" class="mb-4">
        <v-card-title class="text-subtitle-2">工程</v-card-title>
        <v-card-text>
          <input
            ref="projectInputEl"
            type="file"
            accept=".mosaicproj,application/octet-stream"
            style="display: none;"
            @change="handleProjectFileChange"
          />

          <div class="d-flex flex-wrap" style="gap: 0.5rem;">
            <v-btn
              size="small"
              variant="outlined"
              prepend-icon="mdi-import"
              @click="openProjectPicker"
            >
              导入工程
            </v-btn>
            <v-btn
              size="small"
              variant="outlined"
              prepend-icon="mdi-content-save"
              :disabled="store.photoCount === 0"
              @click="handleExportProject"
            >
              导出工程
            </v-btn>
          </div>

          <div class="hint mt-2">工程文件包含布局、参数与原始图片资源。</div>
        </v-card-text>
      </v-card>

      <v-card variant="tonal" class="mb-4">
        <v-card-title class="text-subtitle-2">上传照片</v-card-title>
        <v-card-text>
          <v-file-input
            v-model="selectedFiles"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.HEIC,.heif,.HEIF"
            label="选择照片"
            prepend-icon="mdi-image-multiple"
            chips
            show-size
            density="compact"
            :disabled="isImporting"
          />

          <v-progress-linear
            v-if="isImporting"
            class="mt-3"
            indeterminate
            color="primary"
          />

          <div v-if="store.photoCount > 0" class="photo-list-header">
            <span class="hint">已上传 {{ store.photoCount }} 张照片</span>
            <v-btn size="small" variant="text" @click="clearAll">清空</v-btn>
          </div>

          <PhotoList />
        </v-card-text>
      </v-card>

      <v-card variant="tonal" class="mb-4">
        <v-card-title class="text-subtitle-2">画布尺寸</v-card-title>
        <v-card-text>
          <v-select
            :model-value="store.currentPresetId"
            :items="presetOptions"
            item-title="label"
            item-value="value"
            density="compact"
            label="预设"
            @update:model-value="handlePresetSelect"
          />

          <div class="hint mt-1">
            {{ store.canvasWidth }} × {{ store.canvasHeight }} px (300 DPI)
          </div>

          <v-btn
            class="mt-3"
            color="primary"
            block
            :loading="isArranging"
            :disabled="store.photoCount === 0"
            @click="handleArrange"
          >
            自动排版
          </v-btn>
        </v-card-text>
      </v-card>

      <v-card variant="tonal">
        <v-card-title class="text-subtitle-2">导出设置</v-card-title>
        <v-card-text>
          <v-select
            :model-value="store.exportResolution"
            :items="resolutionOptions"
            item-title="label"
            item-value="value"
            density="compact"
            label="分辨率"
            @update:model-value="handleResolutionSelect"
          />
          <div class="hint mt-1">保持画布宽高比等比缩放导出</div>

          <v-select
            class="mt-3"
            :model-value="store.exportFormat"
            :items="formatOptions"
            item-title="label"
            item-value="value"
            density="compact"
            label="格式"
            @update:model-value="handleFormatSelect"
          />

          <div v-if="store.exportFormat !== 'png'" class="mt-3">
            <div class="d-flex align-center justify-space-between">
              <div class="text-caption">质量</div>
              <div class="text-caption">{{ qualityPercent }}%</div>
            </div>
            <v-slider
              :model-value="store.exportQuality"
              min="0.5"
              max="1"
              step="0.01"
              density="compact"
              @update:model-value="handleQualitySelect"
            />
          </div>

          <v-btn
            color="success"
            block
            :loading="store.isExporting"
            :disabled="store.photoCount === 0"
            @click="handleExport"
          >
            导出拼图
          </v-btn>

          <v-progress-linear
            v-if="store.isExporting && exportProgress"
            class="mt-3"
            :model-value="exportProgress.total ? (exportProgress.done / exportProgress.total) * 100 : 0"
            height="8"
            rounded
          />
          <div
            v-if="store.isExporting && exportProgress"
            class="hint mt-2 d-flex align-center justify-space-between"
          >
            <span>
              {{ exportProgress.label || '处理中...' }}（{{ exportProgress.done }}/{{ exportProgress.total }}）
            </span>
            <v-btn size="small" variant="text" @click="cancelExport">取消</v-btn>
          </div>
        </v-card-text>
      </v-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useMosaicStore } from '@/stores/mosaic'
import { useToastStore } from '@/stores/toast'
import { useUiStore } from '@/stores/ui'
import { isValidImageFile } from '@/utils/image'
import type { ExportFormat, ExportResolutionPreset } from '@/types'
import PhotoList from './PhotoList.vue'

const store = useMosaicStore()
const toast = useToastStore()
const ui = useUiStore()
const isArranging = ref(false)
const isImporting = ref(false)
const selectedFiles = ref<File[]>([])
const projectInputEl = ref<HTMLInputElement | null>(null)
const exportProgress = ref<{ done: number; total: number; label?: string } | null>(null)
const exportAbort = ref<AbortController | null>(null)

const qualityPercent = computed(() => Math.round(store.exportQuality * 100))

const presetOptions = computed(() => store.presets.map(p => ({ label: p.label, value: p.id })))

const resolutionOptions = [
  { label: '原始画布尺寸', value: 'original' },
  { label: '1080p（长边 1920）', value: '1080p' },
  { label: '2K（长边 2560）', value: '2k' },
  { label: '4K（长边 3840）', value: '4k' },
]

const formatOptions = [
  { label: 'PNG（无损）', value: 'png' },
  { label: 'JPEG', value: 'jpeg' },
  { label: 'WebP', value: 'webp' },
]

function handlePresetSelect(v: unknown) {
  store.setPreset(String(v ?? ''))
}

async function expandLeftSidebar() {
  if (!ui.leftSidebarCollapsed) return
  ui.toggleLeftSidebar()
  await nextTick()
}

function handleResolutionSelect(v: ExportResolutionPreset) {
  store.setExportResolution(v)
}

function handleFormatSelect(v: ExportFormat) {
  store.setExportFormat(v)
}

function handleQualitySelect(v: unknown) {
  const num = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isNaN(num)) store.setExportQuality(num)
}

// v-file-input uses v-model; we watch via explicit handler below

async function handleFiles(files: File[]) {
  const validFiles = files.filter(isValidImageFile)
  if (validFiles.length === 0) {
    toast.warning('请选择有效的图片文件（JPEG、PNG、WebP、GIF、HEIC）')
    return
  }

  toast.info(`正在导入 ${validFiles.length} 张照片...`)
  isImporting.value = true

  try {
    const res = await store.addPhotos(validFiles, {
      concurrency: 3,
    })
    if (res.truncated > 0) {
      // 统一提示文案：超过上限时仅保留前 150 张。
      toast.warning('最多支持导入 150 张照片，已自动选择前 150 张')
    }
    if (res.failed > 0) {
      toast.warning(`已导入 ${res.added} 张，失败 ${res.failed} 张（可尝试重新选择失败文件）`)
    } else {
      toast.success(`已导入 ${res.added} 张照片，并完成自动排版`)
    }
  } catch (err) {
    console.error('Import failed:', err)
    toast.error('导入失败，请重试')
  }
  isImporting.value = false
  selectedFiles.value = []
}

// Trigger import when user picks files
watch(
  selectedFiles,
  (v: File[]) => {
    const files = v
    if (files.length === 0) return
    void handleFiles(files)
  },
  { flush: 'post' }
)

async function handleArrange() {
  if (store.photoCount === 0) return
  
  isArranging.value = true
  toast.info('正在计算最佳布局...')

  // 使用 setTimeout 让 UI 更新
  await new Promise(resolve => setTimeout(resolve, 50))

  try {
    await store.autoLayoutWithHistoryAsync('自动排版')
    toast.success('自动排列完成！')
  } catch (err) {
    console.error('Arrange failed:', err)
    toast.error('排列失败，请重试')
  } finally {
    isArranging.value = false
  }
}

// quality slider is handled by handleQualitySelect

async function handleExport() {
  if (store.photoCount === 0) return
  
  store.setExporting(true)
  exportProgress.value = { done: 0, total: store.photoCount, label: '准备中...' }
  exportAbort.value = new AbortController()
  toast.info('正在生成高清拼图...')

  try {
    const { exportMosaicWithOptions } = await import('@/composables/useExport')
    await exportMosaicWithOptions(store, {
      signal: exportAbort.value.signal,
      qualityMode: 'original',
      onProgress: (p) => {
        exportProgress.value = { done: p.done, total: p.total, label: p.label }
      },
    })
    toast.success('导出成功！')
  } catch (err) {
    console.error('Export failed:', err)
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(`导出失败：${msg}`)
  } finally {
    store.setExporting(false)
    exportAbort.value = null
    exportProgress.value = null
  }
}

function cancelExport() {
  exportAbort.value?.abort()
}

function openProjectPicker() {
  projectInputEl.value?.click()
}

async function handleProjectFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  try {
    toast.info('正在导入工程...')
    const { importProjectFile } = await import('@/project/projectFile')
    await importProjectFile({ file, store })
    toast.success('工程导入成功')
  } catch (err) {
    console.error('Import project failed:', err)
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(`导入失败：${msg}`)
  }
}

async function handleExportProject() {
  if (store.photoCount === 0) return
  try {
    toast.info('正在打包工程文件...')
    const { exportProjectFile } = await import('@/project/projectFile')
    await exportProjectFile({ store })
    toast.success('工程文件已导出')
  } catch (err) {
    console.error('Export project failed:', err)
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(`导出失败：${msg}`)
  }
}

function clearAll() {
  if (confirm('确定要清空所有照片吗？')) {
    store.clearAllPhotosWithHistory('清空所有照片')
    toast.info('已清空所有照片')
  }
}
</script>

<style scoped>
.photo-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.5rem;
}
</style>
