import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Toast, ToastType } from '@/types'

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])

  function show(message: string, type: ToastType = 'info', duration: number = 3000) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const toast: Toast = { id, message, type, duration }
    toasts.value.push(toast)

    if (duration > 0) {
      setTimeout(() => {
        remove(id)
      }, duration)
    }

    return id
  }

  function remove(id: string) {
    const index = toasts.value.findIndex(t => t.id === id)
    if (index !== -1) {
      toasts.value.splice(index, 1)
    }
  }

  function success(message: string, duration?: number) {
    return show(message, 'success', duration)
  }

  function error(message: string, duration?: number) {
    return show(message, 'error', duration)
  }

  function info(message: string, duration?: number) {
    return show(message, 'info', duration)
  }

  function warning(message: string, duration?: number) {
    return show(message, 'warning', duration)
  }

  return {
    toasts,
    show,
    remove,
    success,
    error,
    info,
    warning,
  }
})
