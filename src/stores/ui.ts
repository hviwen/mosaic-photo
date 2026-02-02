import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const STORAGE_KEY = 'mosaicPhoto:ui'

type UiState = {
  leftSidebarCollapsed: boolean
  rightSidebarCollapsed: boolean
}

function readStoredUi(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { leftSidebarCollapsed: false, rightSidebarCollapsed: false }
    }
    const parsed = JSON.parse(raw) as Partial<UiState>
    return {
      leftSidebarCollapsed: !!parsed.leftSidebarCollapsed,
      rightSidebarCollapsed: !!parsed.rightSidebarCollapsed,
    }
  } catch {
    return { leftSidebarCollapsed: false, rightSidebarCollapsed: false }
  }
}

export const useUiStore = defineStore('ui', () => {
  const leftSidebarCollapsed = ref(false)
  const rightSidebarCollapsed = ref(false)

  function initUi() {
    const stored = readStoredUi()
    leftSidebarCollapsed.value = stored.leftSidebarCollapsed
    rightSidebarCollapsed.value = stored.rightSidebarCollapsed
  }

  function toggleLeftSidebar() {
    leftSidebarCollapsed.value = !leftSidebarCollapsed.value
  }

  function toggleRightSidebar() {
    rightSidebarCollapsed.value = !rightSidebarCollapsed.value
  }

  watch(
    [leftSidebarCollapsed, rightSidebarCollapsed],
    ([l, r]) => {
      const next: UiState = { leftSidebarCollapsed: l, rightSidebarCollapsed: r }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    },
    { flush: 'post' }
  )

  return {
    leftSidebarCollapsed,
    rightSidebarCollapsed,
    initUi,
    toggleLeftSidebar,
    toggleRightSidebar,
  }
})
