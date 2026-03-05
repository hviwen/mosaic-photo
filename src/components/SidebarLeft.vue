<template>
  <div class="h-100 d-flex flex-column">
    <v-toolbar density="compact" flat>
      <v-avatar size="32" class="mr-2">
        <v-img src="/assets/logo.svg" :alt="t('common.appName')" />
      </v-avatar>
      <v-toolbar-title v-if="!ui.leftSidebarCollapsed">{{ t('common.appName') }}</v-toolbar-title>
      <v-spacer />
      <v-btn
        icon
        variant="text"
        :title="ui.leftSidebarCollapsed ? t('common.expand') : t('common.collapse')"
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
        :title="t('sidebar.left.uploadPhotos')"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-image-multiple" />
      </v-btn>
      <v-btn
        icon
        variant="text"
        :title="t('sidebar.left.canvasSize')"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-aspect-ratio" />
      </v-btn>
      <v-btn
        icon
        variant="text"
        :title="t('sidebar.left.autoLayout')"
        :disabled="store.photoCount === 0"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-auto-fix" />
      </v-btn>
      <v-btn
        icon
        variant="text"
        :title="t('sidebar.left.exportMosaic')"
        :disabled="store.photoCount === 0"
        @click="expandLeftSidebar()"
      >
        <v-icon icon="mdi-export" />
      </v-btn>

      <v-spacer />

      <v-btn
        icon
        variant="text"
        :title="t('common.clear')"
        :disabled="store.photoCount === 0"
        @click="clearAll"
      >
        <v-icon icon="mdi-delete-sweep" />
      </v-btn>
    </div>

    <div v-else class="pa-4 flex-1-1 overflow-y-auto">
      <v-card variant="tonal" class="mb-4">
        <v-card-title class="text-subtitle-2">{{ t('sidebar.left.section.project') }}</v-card-title>
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
              {{ t('sidebar.left.project.import') }}
            </v-btn>
            <v-btn
              size="small"
              variant="outlined"
              prepend-icon="mdi-content-save"
              :disabled="store.photoCount === 0"
              @click="handleExportProject"
            >
              {{ t('sidebar.left.project.export') }}
            </v-btn>
          </div>

          <div class="hint mt-2">{{ t('sidebar.left.project.hint') }}</div>
        </v-card-text>
      </v-card>

      <v-card variant="tonal" class="mb-4">
        <v-card-title class="text-subtitle-2">{{ t('sidebar.left.section.upload') }}</v-card-title>
        <v-card-text>
          <v-file-input
            v-model="selectedFiles"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.HEIC,.heif,.HEIF"
            :label="t('sidebar.left.upload.selectPhotos')"
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
            <span class="hint">{{ t('sidebar.left.upload.uploadedCount', { count: store.photoCount }) }}</span>
            <v-btn size="small" variant="text" @click="clearAll">{{ t('common.clear') }}</v-btn>
          </div>

          <PhotoList />
        </v-card-text>
      </v-card>

      <v-card variant="tonal" class="mb-4">
        <v-card-title class="text-subtitle-2">{{ t('sidebar.left.section.canvas') }}</v-card-title>
        <v-card-text>
          <v-select
            :model-value="store.currentPresetId"
            :items="presetOptions"
            item-title="label"
            item-value="value"
            density="compact"
            :label="t('sidebar.left.canvas.preset')"
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
            {{ t('sidebar.left.autoLayout') }}
          </v-btn>
        </v-card-text>
      </v-card>

      <v-card variant="tonal">
        <v-card-title class="text-subtitle-2">{{ t('sidebar.left.section.export') }}</v-card-title>
        <v-card-text>
          <v-select
            :model-value="store.exportResolution"
            :items="resolutionOptions"
            item-title="label"
            item-value="value"
            density="compact"
            :label="t('sidebar.left.export.resolution')"
            @update:model-value="handleResolutionSelect"
          />
          <div class="hint mt-1">{{ t('sidebar.left.export.keepAspect') }}</div>

          <v-select
            class="mt-3"
            :model-value="store.exportFormat"
            :items="formatOptions"
            item-title="label"
            item-value="value"
            density="compact"
            :label="t('sidebar.left.export.format')"
            @update:model-value="handleFormatSelect"
          />

          <div v-if="store.exportFormat !== 'png'" class="mt-3">
              <div class="d-flex align-center justify-space-between">
              <div class="text-caption">{{ t('sidebar.left.export.quality') }}</div>
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
            {{ t('sidebar.left.exportMosaic') }}
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
              {{ t('sidebar.left.export.progress', {
                label: exportProgress.label || t('common.processing'),
                done: exportProgress.done,
                total: exportProgress.total
              }) }}
            </span>
            <v-btn size="small" variant="text" @click="cancelExport">{{ t('common.cancel') }}</v-btn>
          </div>
        </v-card-text>
      </v-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMosaicStore } from '@/stores/mosaic'
import { useToastStore } from '@/stores/toast'
import { useUiStore } from '@/stores/ui'
import { isValidImageFile } from '@/utils/image'
import type { ExportFormat, ExportResolutionPreset } from '@/types'
import PhotoList from './PhotoList.vue'

const store = useMosaicStore()
const toast = useToastStore()
const ui = useUiStore()
const { t } = useI18n()
const isArranging = ref(false)
const isImporting = ref(false)
const selectedFiles = ref<File[]>([])
const projectInputEl = ref<HTMLInputElement | null>(null)
const exportProgress = ref<{ done: number; total: number; label?: string } | null>(null)
const exportAbort = ref<AbortController | null>(null)

const qualityPercent = computed(() => Math.round(store.exportQuality * 100))

const presetOptions = computed(() =>
  store.presets.map(p => ({ label: t(p.label as any), value: p.id }))
)

const resolutionOptions = computed(() => [
  { label: t('export.resolution.original'), value: 'original' },
  { label: t('export.resolution.1080p'), value: '1080p' },
  { label: t('export.resolution.2k'), value: '2k' },
  { label: t('export.resolution.4k'), value: '4k' },
])

const formatOptions = computed(() => [
  { label: t('export.format.png'), value: 'png' },
  { label: t('export.format.jpeg'), value: 'jpeg' },
  { label: t('export.format.webp'), value: 'webp' },
])

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
    toast.warning(
      t('toast.import.invalidFiles', {
        types: t('common.imageFileTypes'),
      })
    )
    return
  }

  toast.info(t('toast.import.importing', { count: validFiles.length }))
  isImporting.value = true

  try {
    const res = await store.addPhotos(validFiles, {
      concurrency: 3,
    })
    if (res.truncated > 0) {
      // 统一提示文案：超过上限时仅保留前 150 张。
      toast.warning(t('toast.import.maxPhotos'))
    }
    if (res.failed > 0) {
      toast.warning(t('toast.import.partialSuccess', { added: res.added, failed: res.failed }))
    } else {
      toast.success(t('toast.import.success', { count: res.added }))
    }
  } catch (err) {
    console.error('Import failed:', err)
    toast.error(t('toast.import.failed'))
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
  toast.info(t('toast.layout.calculating'))

  // 使用 setTimeout 让 UI 更新
  await new Promise(resolve => setTimeout(resolve, 50))

  try {
    await store.autoLayoutWithHistoryAsync(t('history.action.autoLayout'))
    toast.success(t('toast.layout.success'))
  } catch (err) {
    console.error('Arrange failed:', err)
    toast.error(t('toast.layout.failed'))
  } finally {
    isArranging.value = false
  }
}

// quality slider is handled by handleQualitySelect

async function handleExport() {
  if (store.photoCount === 0) return
  
  store.setExporting(true)
  exportProgress.value = { done: 0, total: store.photoCount, label: t('toast.export.preparing') }
  exportAbort.value = new AbortController()
  toast.info(t('toast.export.start'))

  try {
    const { exportMosaicWithOptions } = await import('@/composables/useExport')
    await exportMosaicWithOptions(store, {
      signal: exportAbort.value.signal,
      qualityMode: 'original',
      onProgress: (p) => {
        exportProgress.value = { done: p.done, total: p.total, label: p.label }
      },
    })
    toast.success(t('toast.export.success'))
  } catch (err) {
    console.error('Export failed:', err)
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(t('toast.export.failed', { message: msg }))
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
    toast.info(t('toast.project.importing'))
    const { importProjectFile } = await import('@/project/projectFile')
    await importProjectFile({ file, store })
    toast.success(t('toast.project.importSuccess'))
  } catch (err) {
    console.error('Import project failed:', err)
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(t('toast.project.importFailed', { message: msg }))
  }
}

async function handleExportProject() {
  if (store.photoCount === 0) return
  try {
    toast.info(t('toast.project.exporting'))
    const { exportProjectFile } = await import('@/project/projectFile')
    await exportProjectFile({ store })
    toast.success(t('toast.project.exportSuccess'))
  } catch (err) {
    console.error('Export project failed:', err)
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(t('toast.project.exportFailed', { message: msg }))
  }
}

function clearAll() {
  if (confirm(t('dialog.clearPhotos'))) {
    store.clearAllPhotosWithHistory(t('history.action.clearAll'))
    toast.info(t('toast.photos.cleared'))
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
