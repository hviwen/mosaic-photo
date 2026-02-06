<template>
  <div class="h-100 d-flex flex-column">
    <v-toolbar density="compact" flat>
      <v-toolbar-title v-if="!ui.rightSidebarCollapsed">照片属性</v-toolbar-title>
      <v-spacer />
      <v-btn
        icon
        variant="text"
        :title="ui.rightSidebarCollapsed ? '展开' : '折叠'"
        @click="ui.toggleRightSidebar()"
      >
        <v-icon :icon="ui.rightSidebarCollapsed ? 'mdi-chevron-left' : 'mdi-chevron-right'" />
      </v-btn>

      <v-btn
        icon
        variant="text"
        :title="themeStore.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
        @click="themeStore.toggleTheme()"
      >
        <v-icon :icon="themeStore.theme === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'" />
      </v-btn>
    </v-toolbar>
    <v-divider />

    <div v-if="ui.rightSidebarCollapsed" class="py-3 px-2 flex-1-1 d-flex flex-column align-center">
      <v-btn
        icon
        variant="text"
        title="照片属性"
        @click="expandRightSidebar()"
      >
        <v-icon icon="mdi-tune-variant" />
      </v-btn>

      <v-btn
        icon
        variant="text"
        :title="selectedPhoto ? '删除照片' : '在画布上选择一张照片'"
        :disabled="!selectedPhoto"
        @click="deletePhoto"
      >
        <v-icon icon="mdi-delete" />
      </v-btn>

      <v-spacer />
    </div>

    <div v-else class="pa-4 flex-1-1 overflow-y-auto">
      <v-alert v-if="!selectedPhoto" type="info" variant="tonal" density="compact">
        在画布上选择一张照片
      </v-alert>

      <div v-else>
        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">当前选中</v-card-title>
          <v-card-text>
            <div class="d-flex flex-column" style="gap: 0.25rem;">
              <div class="text-caption">文件：{{ selectedPhoto.name }}</div>
              <div class="text-caption">尺寸：{{ selectedPhoto.imageWidth }} × {{ selectedPhoto.imageHeight }}</div>
              <div class="text-caption">
                裁剪：{{ Math.round(selectedPhoto.crop.width) }} × {{ Math.round(selectedPhoto.crop.height) }}
              </div>
              <div class="text-caption">图层：{{ selectedPhoto.zIndex }}</div>
            </div>
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">原图缩略</v-card-title>
          <v-card-text>
            <v-img
              :src="previewSrc"
              :aspect-ratio="previewAspect"
              height="180"
              :cover="false"
              class="rounded"
            />
            <div class="text-caption mt-2">保持宽高比等比缩放展示（不受裁剪/滤镜影响）</div>
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">操作历史</v-card-title>
          <v-card-text>
            <div class="d-flex flex-wrap" style="gap: 0.5rem;">
              <v-btn
                size="small"
                variant="outlined"
                :disabled="!store.canUndo"
                prepend-icon="mdi-undo"
                @click="store.undo()"
              >
                撤销
              </v-btn>
              <v-btn
                size="small"
                variant="outlined"
                :disabled="!store.canRedo"
                prepend-icon="mdi-redo"
                @click="store.redo()"
              >
                重做
              </v-btn>
              <v-spacer />
              <v-btn
                size="small"
                variant="text"
                :disabled="store.history.length === 0"
                prepend-icon="mdi-delete-sweep"
                @click="clearHistory"
              >
                清空
              </v-btn>
            </div>

            <v-divider class="my-3" />

            <v-alert v-if="store.history.length === 0" type="info" variant="tonal" density="compact">
              暂无操作记录
            </v-alert>

            <v-list v-else density="compact">
              <v-list-item
                v-for="(item, idx) in historyItems"
                :key="item.id"
                :title="item.label"
                :subtitle="formatHistorySubtitle(item, idx)"
              />
            </v-list>
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">替换图片</v-card-title>
          <v-card-text>
            <v-alert type="info" variant="tonal" density="compact" class="mb-3">
              仅替换图片内容，保持当前位置与显示尺寸不变。
            </v-alert>
            <input
              ref="replaceInputEl"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style="display: none;"
              @change="handleReplaceFileChange"
            />
            <v-btn
              block
              variant="outlined"
              prepend-icon="mdi-image-edit"
              :loading="isReplacing"
              @click="openReplacePicker"
            >
              选择新图片
            </v-btn>
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">位置</v-card-title>
          <v-card-text>
            <v-text-field
              :model-value="Math.round(selectedPhoto.cx)"
              type="number"
              density="compact"
              label="X"
              @update:model-value="(v) => updatePosition('cx', v)"
            />
            <v-text-field
              :model-value="Math.round(selectedPhoto.cy)"
              type="number"
              density="compact"
              label="Y"
              @update:model-value="(v) => updatePosition('cy', v)"
            />
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">变换</v-card-title>
          <v-card-text>
            <div class="d-flex align-center justify-space-between">
              <div class="text-caption">缩放</div>
              <div class="text-caption">{{ scalePercent }}%</div>
            </div>
            <v-slider
              :model-value="selectedPhoto.scale"
              min="0.05"
              max="3"
              step="0.01"
              density="compact"
              @update:model-value="updateScale"
            />

            <div class="d-flex align-center justify-space-between mt-3">
              <div class="text-caption">旋转</div>
              <div class="text-caption">{{ rotationDeg }}°</div>
            </div>
            <v-slider
              :model-value="radiansToDegrees(selectedPhoto.rotation)"
              min="-180"
              max="180"
              step="1"
              density="compact"
              @update:model-value="updateRotation"
            />
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">图层</v-card-title>
          <v-card-text>
            <div class="d-flex flex-wrap" style="gap: 0.5rem;">
              <v-btn size="small" variant="outlined" @click="bringToFront" prepend-icon="mdi-arrow-up">
                置顶
              </v-btn>
              <v-btn size="small" variant="outlined" @click="sendToBack" prepend-icon="mdi-arrow-down">
                置底
              </v-btn>
            </div>
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">裁剪</v-card-title>
          <v-card-text>
            <div class="text-caption mb-3">
              当前裁剪区域: {{ Math.round(selectedPhoto.crop.width) }} × {{ Math.round(selectedPhoto.crop.height) }}
            </div>
            <v-btn class="mt-3" block variant="outlined" prepend-icon="mdi-crop" @click="enterCropMode">
              裁剪照片
            </v-btn>
          </v-card-text>
        </v-card>

        <v-card variant="tonal" class="mb-4">
          <v-card-title class="text-subtitle-2">调色与滤镜</v-card-title>
          <v-card-text>
            <div class="d-flex align-center justify-space-between">
              <div class="text-caption">亮度</div>
              <div class="text-caption">{{ Math.round((adjustDraft.brightness ?? 1) * 100) }}%</div>
            </div>
            <v-slider
              :model-value="adjustDraft.brightness"
              min="0.5"
              max="1.6"
              step="0.01"
              density="compact"
              @update:model-value="(v) => updateAdjustments('brightness', v)"
            />

            <div class="d-flex align-center justify-space-between mt-3">
              <div class="text-caption">对比度</div>
              <div class="text-caption">{{ Math.round((adjustDraft.contrast ?? 1) * 100) }}%</div>
            </div>
            <v-slider
              :model-value="adjustDraft.contrast"
              min="0.5"
              max="1.8"
              step="0.01"
              density="compact"
              @update:model-value="(v) => updateAdjustments('contrast', v)"
            />

            <div class="d-flex align-center justify-space-between mt-3">
              <div class="text-caption">饱和度</div>
              <div class="text-caption">{{ Math.round((adjustDraft.saturation ?? 1) * 100) }}%</div>
            </div>
            <v-slider
              :model-value="adjustDraft.saturation"
              min="0"
              max="2"
              step="0.01"
              density="compact"
              @update:model-value="(v) => updateAdjustments('saturation', v)"
            />

            <v-select
              class="mt-3"
              :model-value="adjustDraft.preset"
              :items="filterOptions"
              item-title="label"
              item-value="value"
              density="compact"
              label="滤镜"
              @update:model-value="(v) => updateAdjustments('preset', v)"
            />

            <div class="d-flex flex-wrap mt-3" style="gap: 0.5rem;">
              <v-btn size="small" color="primary" variant="tonal" @click="applyAdjustments" :disabled="!hasAdjustmentChanges">
                应用
              </v-btn>
              <v-btn size="small" variant="outlined" @click="resetAdjustments" :disabled="!hasAdjustmentChanges">
                重置
              </v-btn>
            </div>
          </v-card-text>
        </v-card>

        <v-btn color="error" variant="tonal" block @click="deletePhoto" prepend-icon="mdi-delete">
          删除照片
        </v-btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useMosaicStore } from '@/stores/mosaic'
import { useToastStore } from '@/stores/toast'
import { useThemeStore } from '@/stores/theme'
import { useUiStore } from '@/stores/ui'
import { radiansToDegrees, degreesToRadians } from '@/utils/math'
import type { FilterPreset, PhotoAdjustments } from '@/types'

const store = useMosaicStore()
const toast = useToastStore()
const themeStore = useThemeStore()
const ui = useUiStore()

const selectedPhoto = computed(() => store.selectedPhoto)
const previewSrc = computed(() => selectedPhoto.value?.srcUrl ?? '')
const previewAspect = computed(() => {
  const p = selectedPhoto.value
  if (!p) return 1
  const w = Math.max(1, p.imageWidth)
  const h = Math.max(1, p.imageHeight)
  return w / h
})

const scalePercent = computed(() => 
  selectedPhoto.value ? Math.round(selectedPhoto.value.scale * 100) : 0
)

const rotationDeg = computed(() => 
  selectedPhoto.value ? Math.round(radiansToDegrees(selectedPhoto.value.rotation)) : 0
)

const historyItems = computed(() => store.history.slice(-12).reverse())

const filterOptions: Array<{ label: string; value: FilterPreset }> = [
  { label: '无', value: 'none' },
  { label: '黑白', value: 'blackWhite' },
  { label: '棕褐色', value: 'sepia' },
  { label: '复古', value: 'vintage' },
]

const replaceInputEl = ref<HTMLInputElement | null>(null)
const isReplacing = ref(false)

const adjustDraft = ref<PhotoAdjustments>({
  brightness: 1,
  contrast: 1,
  saturation: 1,
  preset: 'none',
})
const adjustStart = ref<PhotoAdjustments | null>(null)

const hasAdjustmentChanges = computed(() => {
  if (!selectedPhoto.value || !adjustStart.value) return false
  const a = adjustStart.value
  const b = adjustDraft.value
  return (
    a.brightness !== b.brightness ||
    a.contrast !== b.contrast ||
    a.saturation !== b.saturation ||
    a.preset !== b.preset
  )
})

const transformStart = ref<{ scale: number; rotation: number } | null>(null)
const transformTimer = ref<number | null>(null)

async function expandRightSidebar() {
  if (!ui.rightSidebarCollapsed) return
  ui.toggleRightSidebar()
  await nextTick()
  window.dispatchEvent(new Event('resize'))
}

watch(
  () => [store.canvasWidth, store.canvasHeight, ui.rightSidebarCollapsed],
  async ([, , collapsed]) => {
    if (collapsed) return
    await nextTick()
    window.dispatchEvent(new Event('resize'))
  }
)

function updatePosition(axis: 'cx' | 'cy', v: unknown) {
  if (!selectedPhoto.value) return
  const value = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isNaN(value)) {
    store.updatePhotoWithHistory(selectedPhoto.value.id, { [axis]: value }, axis === 'cx' ? '移动（X）' : '移动（Y）')
  }
}

function updateScale(v: unknown) {
  if (!selectedPhoto.value) return
  const value = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isNaN(value)) {
    if (!transformStart.value) {
      transformStart.value = { scale: selectedPhoto.value.scale, rotation: selectedPhoto.value.rotation }
    }
    store.updatePhoto(selectedPhoto.value.id, { scale: value })
    scheduleTransformCommit()
  }
}

function updateRotation(v: unknown) {
  if (!selectedPhoto.value) return
  const deg = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isNaN(deg)) {
    if (!transformStart.value) {
      transformStart.value = { scale: selectedPhoto.value.scale, rotation: selectedPhoto.value.rotation }
    }
    store.updatePhoto(selectedPhoto.value.id, { rotation: degreesToRadians(deg) })
    scheduleTransformCommit()
  }
}

function bringToFront() {
  if (!selectedPhoto.value) return
  store.bringToFrontWithHistory(selectedPhoto.value.id)
}

function sendToBack() {
  if (!selectedPhoto.value) return
  store.sendToBackWithHistory(selectedPhoto.value.id)
}

function enterCropMode() {
  if (!selectedPhoto.value) return
  store.setCropMode(selectedPhoto.value.id)
  toast.info('裁剪模式：拖动调整裁剪区域，按 Enter 确认，Esc 取消')
}

function scheduleTransformCommit() {
  if (!selectedPhoto.value || !transformStart.value) return
  if (transformTimer.value != null) {
    window.clearTimeout(transformTimer.value)
    transformTimer.value = null
  }

  transformTimer.value = window.setTimeout(() => {
    if (!selectedPhoto.value || !transformStart.value) return
    const before = transformStart.value
    const after = { scale: selectedPhoto.value.scale, rotation: selectedPhoto.value.rotation }
    transformStart.value = null
    transformTimer.value = null

    const changedScale = before.scale !== after.scale
    const changedRot = before.rotation !== after.rotation
    if (!changedScale && !changedRot) return

    const label = changedScale && changedRot ? '变换' : changedScale ? '缩放' : '旋转'
    store.pushPhotoHistoryFromPartials(selectedPhoto.value.id, label, before, after)
  }, 350)
}

function openReplacePicker() {
  if (!selectedPhoto.value) return
  replaceInputEl.value?.click()
}

async function handleReplaceFileChange(e: Event) {
  if (!selectedPhoto.value) return
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  isReplacing.value = true
  try {
    await store.replacePhotoFromFile(selectedPhoto.value.id, file)
    toast.success('图片已替换')
  } catch (err) {
    console.error('Replace failed:', err)
    toast.error('替换失败，请重试')
  } finally {
    isReplacing.value = false
  }
}

function updateAdjustments<K extends keyof PhotoAdjustments>(key: K, v: unknown) {
  if (!selectedPhoto.value) return
  const next = { ...adjustDraft.value }
  if (key === 'preset') {
    next.preset = String(v ?? 'none') as FilterPreset
  } else {
    const num = typeof v === 'number' ? v : parseFloat(String(v))
    if (Number.isNaN(num)) return
    next[key] = num as PhotoAdjustments[K]
  }
  adjustDraft.value = next
  store.setPhotoAdjustments(selectedPhoto.value.id, next)
}

function applyAdjustments() {
  if (!selectedPhoto.value || !adjustStart.value) return
  if (!hasAdjustmentChanges.value) return
  const before = adjustStart.value
  const after = adjustDraft.value
  store.pushPhotoHistoryFromPartials(selectedPhoto.value.id, '调色/滤镜', { adjustments: before }, { adjustments: after })
  adjustStart.value = { ...after }
  toast.success('已应用调色/滤镜')
}

function resetAdjustments() {
  if (!selectedPhoto.value || !adjustStart.value) return
  adjustDraft.value = { ...adjustStart.value }
  store.setPhotoAdjustments(selectedPhoto.value.id, adjustDraft.value)
}

function clearHistory() {
  if (confirm('确定要清空操作历史吗？')) {
    store.clearHistory()
    toast.info('已清空操作历史')
  }
}

function formatHistorySubtitle(item: any, idx: number) {
  const time = new Date(item.at).toLocaleTimeString()
  if (idx === 0) return `最新 · ${time}`
  return time
}

watch(
  () => selectedPhoto.value?.id,
  (id) => {
    transformStart.value = null
    if (transformTimer.value != null) {
      window.clearTimeout(transformTimer.value)
      transformTimer.value = null
    }
    if (!id || !selectedPhoto.value) return
    adjustDraft.value = { ...selectedPhoto.value.adjustments }
    adjustStart.value = { ...selectedPhoto.value.adjustments }
  },
  { immediate: true }
)

function deletePhoto() {
  if (!selectedPhoto.value) return
  if (confirm('确定要删除这张照片吗？')) {
    store.removePhotoWithHistory(selectedPhoto.value.id, `删除照片：${selectedPhoto.value.name}`)
  }
}
</script>
