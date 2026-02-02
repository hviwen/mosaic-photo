import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY = 'mosaicPhoto:theme'

function applyThemeToDom(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

function readStoredTheme(): ThemeMode {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === 'light' ? 'light' : 'dark'
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>('dark')

  function initTheme() {
    theme.value = readStoredTheme()
    applyThemeToDom(theme.value)
  }

  function setTheme(next: ThemeMode) {
    theme.value = next
  }

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  watch(
    theme,
    (t) => {
      localStorage.setItem(STORAGE_KEY, t)
      applyThemeToDom(t)
    },
    { flush: 'post' }
  )

  return { theme, initTheme, setTheme, toggleTheme }
})
