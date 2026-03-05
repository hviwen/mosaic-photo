import { describe, expect, it } from 'vitest'
import zhCN from '@/locales/zh-CN.json'
import enUS from '@/locales/en-US.json'
import jaJP from '@/locales/ja-JP.json'
import koKR from '@/locales/ko-KR.json'

function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return prefix ? [prefix] : []
  }

  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    const children = flattenKeys(v, path)
    if (children.length === 0) out.push(path)
    else out.push(...children)
  }
  return out
}

describe('locale message schema consistency', () => {
  it('all locales should have the same key structure as zh-CN', () => {
    const base = flattenKeys(zhCN).sort()
    const targets = [
      { locale: 'en-US', data: enUS },
      { locale: 'ja-JP', data: jaJP },
      { locale: 'ko-KR', data: koKR },
    ]

    for (const target of targets) {
      const keys = flattenKeys(target.data).sort()
      expect(keys, `${target.locale} keys must match zh-CN`).toEqual(base)
    }
  })
})
