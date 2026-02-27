<template>
  <v-app>
    <Analytics />
    <v-navigation-drawer
      location="left"
      permanent
      :rail="ui.leftSidebarCollapsed"
      :width="360"
      :rail-width="56"
      class="app-drawer app-drawer--left"
    >
      <SidebarLeft />
    </v-navigation-drawer>

    <v-navigation-drawer
      location="right"
      permanent
      :rail="ui.rightSidebarCollapsed"
      :width="340"
      :rail-width="56"
      class="app-drawer app-drawer--right"
    >
      <SidebarRight />
    </v-navigation-drawer>

    <v-main>
      <div class="main-content">
        <CanvasStage />
      </div>
      <ToastContainer />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { Analytics } from '@vercel/analytics/vue'
import SidebarLeft from '@/components/SidebarLeft.vue'
import SidebarRight from '@/components/SidebarRight.vue'
import CanvasStage from '@/components/CanvasStage.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
</script>
