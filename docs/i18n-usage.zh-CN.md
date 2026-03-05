# i18n 使用说明（Vue3 + vue-i18n）

## 1. 架构概览
- 插件入口：`src/plugins/i18n.ts`
- 核心配置：`src/locales/index.ts`
- 语言包：`src/locales/zh-CN.json`、`en-US.json`、`ja-JP.json`、`ko-KR.json`
- 状态管理：`src/stores/ui.ts`（`locale` 持久化到 localStorage）

## 2. 设计约定
- 默认语言固定为 `zh-CN`
- 回退语言为 `en-US`
- `zh-CN` 同步加载，其他语言懒加载
- 翻译 key 使用英文小写点分层命名，例如：`sidebar.left.export.format`

## 3. 开发中如何使用

### 3.1 在组件中
```ts
import { useI18n } from 'vue-i18n'

const { t, d } = useI18n()
```

模板中：
```vue
<span>{{ t('canvas.preview') }}</span>
```

脚本中：
```ts
toast.success(t('toast.export.success'))
```

### 3.2 在非组件模块中
使用全局 helper：
```ts
import { translate } from '@/locales'

throw new Error(translate('export.errors.contextUnavailable'))
```

## 4. 新增文案流程
1. 先在 `zh-CN.json` 增加 key。
2. 同步在 `en-US/ja-JP/ko-KR` 增加同结构 key。
3. 在代码中使用 `t(...)` 或 `translate(...)` 替换硬编码。
4. 执行：
   - `pnpm typecheck`
   - `pnpm test`

## 5. 时间与数字格式
- 时间格式通过 `d(value, 'timeShort')` 输出。
- 百分比等数字格式通过 `n(value, 'percent')`（如需要）输出。

## 6. 语言切换与持久化
- UI 中通过右侧栏顶部语言菜单切换。
- `useUiStore().setLocale(locale)` 会：
  - 懒加载语言包（如果未加载）
  - 更新 `i18n.global.locale`
  - 更新 `document.documentElement.lang`
  - 写入 localStorage

## 7. 常见问题
- 缺 key：开发环境会有 `missingWarn` / `fallbackWarn` 提示。
- 回退规则：先回退 `en-US`，仍缺失则显示 key。
- 文案溢出：切换到日文/韩文后需重点检查按钮与提示条宽度。

## 8. 检查清单
- [ ] 所有用户可见文本已移除硬编码
- [ ] `title/label/alt/aria-label` 已国际化
- [ ] 四个语言包 key 结构一致
- [ ] 默认语言、回退语言、懒加载行为符合预期
