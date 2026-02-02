import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
import { watch } from 'vue'
import vuetify from '@/plugins/vuetify'

import { useThemeStore } from '@/stores/theme'
import { useUiStore } from '@/stores/ui'

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

app.use(vuetify)
app.mount('#app')
