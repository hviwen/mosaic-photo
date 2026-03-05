import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useUiStore } from '@/stores/ui'
import i18n from '@/locales'

type StorageMap = Map<string, string>

function createStorage(map: StorageMap): Storage {
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null
    },
    removeItem(key: string) {
      map.delete(key)
    },
    setItem(key: string, value: string) {
      map.set(key, value)
    },
  }
}

describe('useUiStore locale persistence', () => {
  const storageMap: StorageMap = new Map()

  beforeEach(() => {
    storageMap.clear()
    setActivePinia(createPinia())
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: createStorage(storageMap),
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { lang: '' } },
    })
    i18n.global.locale.value = 'zh-CN'
  })

  it('uses zh-CN by default on first launch', async () => {
    const ui = useUiStore()
    await ui.initUi()

    expect(ui.locale).toBe('zh-CN')
    expect(i18n.global.locale.value).toBe('zh-CN')
    expect((globalThis as any).document.documentElement.lang).toBe('zh-CN')
  })

  it('persists locale to localStorage when changed', async () => {
    const ui = useUiStore()
    await ui.initUi()

    await ui.setLocale('en-US')
    await nextTick()

    const raw = localStorage.getItem('mosaicPhoto:ui')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.locale).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
  })

  it('restores stored locale during init', async () => {
    localStorage.setItem(
      'mosaicPhoto:ui',
      JSON.stringify({
        leftSidebarCollapsed: true,
        rightSidebarCollapsed: false,
        locale: 'ja-JP',
      }),
    )

    const ui = useUiStore()
    await ui.initUi()

    expect(ui.locale).toBe('ja-JP')
    expect(ui.leftSidebarCollapsed).toBe(true)
    expect(i18n.global.locale.value).toBe('ja-JP')
  })
})
