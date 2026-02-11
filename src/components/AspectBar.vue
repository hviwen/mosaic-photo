<template>
  <div class="aspect-bar" :class="{ 'aspect-bar--active': active }">
    <div class="aspect-bar__track">
      <div
        class="aspect-bar__line aspect-bar__line--width"
        :style="{ width: widthPercent + '%' }" />
      <div
        class="aspect-bar__line aspect-bar__line--height"
        :style="{ width: heightPercent + '%' }" />
    </div>
    <span class="aspect-bar__label">{{ aspect }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  width: number | string;
  height: number | string;
  aspect: string;
  active?: boolean;
}>();

const w = computed(() => Number(props.width) || 1);
const h = computed(() => Number(props.height) || 1);
const maxDim = computed(() => Math.max(w.value, h.value));

const widthPercent = computed(() => (w.value / maxDim.value) * 100);
const heightPercent = computed(() => (h.value / maxDim.value) * 100);
</script>

<style scoped>
.aspect-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 18px;
}

.aspect-bar__track {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
}

.aspect-bar__line {
  height: 3px;
  border-radius: 1.5px;
  transform-origin: left center;
  transition:
    width 250ms ease,
    box-shadow 250ms ease,
    opacity 250ms ease;
}

.aspect-bar__line--width {
  background: #6366f1;
}

.aspect-bar__line--height {
  background: #06b6d4;
}

/* Active state: glow + brighter colors */
.aspect-bar--active .aspect-bar__line--width {
  background: #818cf8;
  box-shadow: 0 0 6px rgba(99, 102, 241, 0.5);
}

.aspect-bar--active .aspect-bar__line--height {
  background: #22d3ee;
  box-shadow: 0 0 6px rgba(6, 182, 212, 0.4);
}

.aspect-bar__label {
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  min-width: 2.2em;
  text-align: right;
  line-height: 1;
}

.aspect-bar--active .aspect-bar__label {
  color: rgba(255, 255, 255, 0.75);
}

/* Respect prefers-reduced-motion */
@media (prefers-reduced-motion: reduce) {
  .aspect-bar__line {
    transition: none;
  }
}
</style>
