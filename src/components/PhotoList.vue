<template>
  <div v-if="store.photos.length > 0" class="photo-list">
    <div 
      v-for="photo in store.photos" 
      :key="photo.id"
      class="photo-thumb"
      :class="{ 'photo-thumb--selected': photo.id === store.selectedPhotoId }"
      @click="store.selectPhoto(photo.id)"
    >
      <img :src="photo.srcUrl" :alt="photo.name" />
      <button 
        class="photo-thumb__remove"
        @click.stop="removePhoto(photo.id)"
        title="删除"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMosaicStore } from '@/stores/mosaic'

const store = useMosaicStore()

function removePhoto(id: string) {
  store.removePhoto(id)
}
</script>
