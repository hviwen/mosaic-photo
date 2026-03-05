import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  DEFAULT_LOCALE,
  LOCALES,
  type AppLocale,
  setI18nLocale,
} from '@/locales'

const STORAGE_KEY = 'mosaicPhoto:ui'

type UiState = {
  leftSidebarCollapsed: boolean
  rightSidebarCollapsed: boolean
  locale: AppLocale
}

function readStoredUi(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {
        leftSidebarCollapsed: false,
        rightSidebarCollapsed: false,
        locale: DEFAULT_LOCALE,
      }
    }
    const parsed = JSON.parse(raw) as Partial<UiState>
    const locale = LOCALES.includes(parsed.locale as AppLocale)
      ? (parsed.locale as AppLocale)
      : DEFAULT_LOCALE
    return {
      leftSidebarCollapsed: !!parsed.leftSidebarCollapsed,
      rightSidebarCollapsed: !!parsed.rightSidebarCollapsed,
      locale,
    }
  } catch {
    return {
      leftSidebarCollapsed: false,
      rightSidebarCollapsed: false,
      locale: DEFAULT_LOCALE,
    }
  }
}

export const useUiStore = defineStore('ui', () => {
  const leftSidebarCollapsed = ref(false)
  const rightSidebarCollapsed = ref(false)
  const locale = ref<AppLocale>(DEFAULT_LOCALE)

  async function initUi() {
    const stored = readStoredUi()
    leftSidebarCollapsed.value = stored.leftSidebarCollapsed
    rightSidebarCollapsed.value = stored.rightSidebarCollapsed
    await setLocale(stored.locale)
  }

  function toggleLeftSidebar() {
    leftSidebarCollapsed.value = !leftSidebarCollapsed.value
  }

  function toggleRightSidebar() {
    rightSidebarCollapsed.value = !rightSidebarCollapsed.value
  }

  async function setLocale(next: AppLocale) {
    if (!LOCALES.includes(next)) return
    locale.value = next
    await setI18nLocale(next)
  }

  watch(
    [leftSidebarCollapsed, rightSidebarCollapsed, locale],
    ([l, r, nextLocale]) => {
      const next: UiState = {
        leftSidebarCollapsed: l,
        rightSidebarCollapsed: r,
        locale: nextLocale,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    },
    { flush: 'post' }
  )

  return {
    leftSidebarCollapsed,
    rightSidebarCollapsed,
    locale,
    initUi,
    toggleLeftSidebar,
    toggleRightSidebar,
    setLocale,
  }
})
