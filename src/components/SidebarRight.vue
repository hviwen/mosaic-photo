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

    <div class="pa-4 flex-1-1 overflow-y-auto">
      <v-alert v-if="!selectedPhoto" type="info" variant="tonal" density="compact">
        在画布上选择一张照片
      </v-alert>

      <div v-else>
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
            <div class="d-flex flex-wrap" style="gap: 0.5rem;">
              <v-btn size="small" variant="outlined" :disabled="!store.canUndoCrop" @click="store.undoCrop()">
                撤销
              </v-btn>
              <v-btn size="small" variant="outlined" :disabled="!store.canRedoCrop" @click="store.redoCrop()">
                重做
              </v-btn>
            </div>
            <v-btn class="mt-3" block variant="outlined" prepend-icon="mdi-crop" @click="enterCropMode">
              裁剪照片
            </v-btn>
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
import { computed } from 'vue'
import { useMosaicStore } from '@/stores/mosaic'
import { useToastStore } from '@/stores/toast'
import { useThemeStore } from '@/stores/theme'
import { useUiStore } from '@/stores/ui'
import { radiansToDegrees, degreesToRadians } from '@/utils/math'

const store = useMosaicStore()
const toast = useToastStore()
const themeStore = useThemeStore()
const ui = useUiStore()

const selectedPhoto = computed(() => store.selectedPhoto)

const scalePercent = computed(() => 
  selectedPhoto.value ? Math.round(selectedPhoto.value.scale * 100) : 0
)

const rotationDeg = computed(() => 
  selectedPhoto.value ? Math.round(radiansToDegrees(selectedPhoto.value.rotation)) : 0
)

function updatePosition(axis: 'cx' | 'cy', v: unknown) {
  if (!selectedPhoto.value) return
  const value = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isNaN(value)) {
    store.updatePhoto(selectedPhoto.value.id, { [axis]: value })
  }
}

function updateScale(v: unknown) {
  if (!selectedPhoto.value) return
  const value = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isNaN(value)) {
    store.updatePhoto(selectedPhoto.value.id, { scale: value })
  }
}

function updateRotation(v: unknown) {
  if (!selectedPhoto.value) return
  const deg = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isNaN(deg)) {
    store.updatePhoto(selectedPhoto.value.id, { rotation: degreesToRadians(deg) })
  }
}

function bringToFront() {
  if (!selectedPhoto.value) return
  store.bringToFront(selectedPhoto.value.id)
}

function sendToBack() {
  if (!selectedPhoto.value) return
  store.sendToBack(selectedPhoto.value.id)
}

function enterCropMode() {
  if (!selectedPhoto.value) return
  store.setCropMode(selectedPhoto.value.id)
  toast.info('裁剪模式：拖动调整裁剪区域，按 Enter 确认，Esc 取消')
}

function deletePhoto() {
  if (!selectedPhoto.value) return
  if (confirm('确定要删除这张照片吗？')) {
    store.removePhoto(selectedPhoto.value.id)
  }
}
</script>
