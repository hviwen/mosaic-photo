import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
import { watch } from 'vue'
import vuetify from '@/plugins/vuetify'

import { useThemeStore } from '@/stores/theme'
import { useUiStore } from '@/stores/ui'
import { useMosaicStore } from '@/stores/mosaic'
import { loadLatestProject, scheduleAutosave } from '@/project/persistence'
import { hydratePhotosFromProject } from '@/project/applyProject'

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)

// Ensure theme is applied ASAP (avoid flashing wrong theme)
const themeStore = useThemeStore(pinia)
themeStore.initTheme()
useUiStore(pinia).initUi()

// Sync Vuetify theme with the existing theme store
vuetify.theme.global.name.value = themeStore.theme
watch(
	() => themeStore.theme,
	(t) => {
		vuetify.theme.global.name.value = t
	},
	{ flush: 'post' }
)

// Restore latest project (best-effort) and set up autosave
const mosaicStore = useMosaicStore(pinia)
try {
	const latest = await loadLatestProject()
	if (latest) {
		mosaicStore.clearAllPhotos()
		mosaicStore.setExportFormat(latest.export.format)
		mosaicStore.setExportQuality(latest.export.quality)
		mosaicStore.setExportResolution(latest.export.resolution)
		// Restore without triggering auto-layout during hydration.
		mosaicStore.currentPresetId = latest.canvas.presetId
		mosaicStore.canvasWidth = latest.canvas.width
		mosaicStore.canvasHeight = latest.canvas.height

		const hydrated = await hydratePhotosFromProject({
			project: latest,
			canvasWidth: mosaicStore.canvasWidth,
			canvasHeight: mosaicStore.canvasHeight,
		})
		mosaicStore.photos = hydrated
		mosaicStore.selectPhoto(hydrated[0]?.id ?? null)
	}
} catch (e) {
	// Best-effort restore: ignore failures to avoid blocking app.
	console.warn('Project restore failed:', e)
}

// Debounced autosave; avoid saving during high-frequency interactions.
mosaicStore.$subscribe(
	() => {
		if (mosaicStore.mode.kind !== 'idle') return
		scheduleAutosave({ store: mosaicStore, delayMs: 800 })
	},
	{ detached: true }
)

watch(
	() => mosaicStore.mode.kind,
	(kind) => {
		if (kind === 'idle') scheduleAutosave({ store: mosaicStore, delayMs: 300 })
	},
	{ flush: 'post' }
)

app.use(vuetify)
app.mount('#app')
