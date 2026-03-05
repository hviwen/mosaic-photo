import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN.json'

export const LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as const
export type AppLocale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: AppLocale = 'zh-CN'
export const FALLBACK_LOCALE: AppLocale = 'en-US'

export type MessageSchema = typeof zhCN

type Primitive = string | number | boolean | null | undefined
export type I18nKey<T = MessageSchema> = T extends Primitive
  ? never
  : {
      [K in keyof T & string]: T[K] extends Primitive
        ? K
        : `${K}` | `${K}.${I18nKey<T[K]>}`
    }[keyof T & string]

const loadedLocales = new Set<AppLocale>([DEFAULT_LOCALE])

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  messages: {
    [DEFAULT_LOCALE]: zhCN,
  },
  datetimeFormats: {
    'zh-CN': {
      timeShort: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
    },
    'en-US': {
      timeShort: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true },
    },
    'ja-JP': {
      timeShort: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
    },
    'ko-KR': {
      timeShort: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
    },
  },
  numberFormats: {
    'zh-CN': {
      percent: { style: 'percent', maximumFractionDigits: 0 },
    },
    'en-US': {
      percent: { style: 'percent', maximumFractionDigits: 0 },
    },
    'ja-JP': {
      percent: { style: 'percent', maximumFractionDigits: 0 },
    },
    'ko-KR': {
      percent: { style: 'percent', maximumFractionDigits: 0 },
    },
  },
  missingWarn: import.meta.env.DEV,
  fallbackWarn: import.meta.env.DEV,
})

export async function loadLocaleMessages(locale: AppLocale): Promise<void> {
  if (loadedLocales.has(locale)) return

  let mod: { default: MessageSchema }
  switch (locale) {
    case 'en-US':
      mod = await import('./en-US.json')
      break
    case 'ja-JP':
      mod = await import('./ja-JP.json')
      break
    case 'ko-KR':
      mod = await import('./ko-KR.json')
      break
    case 'zh-CN':
      mod = { default: zhCN }
      break
    default:
      mod = await import('./en-US.json')
      break
  }

  i18n.global.setLocaleMessage(locale, mod.default as any)
  loadedLocales.add(locale)
}

export async function setI18nLocale(locale: AppLocale): Promise<void> {
  await loadLocaleMessages(locale)
  i18n.global.locale.value = locale
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

export function translate(key: I18nKey, params?: Record<string, unknown>): string {
  return i18n.global.t(key as any, params as any) as string
}

export default i18n
