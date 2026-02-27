// Stub for vue-router when it's not installed
// This allows @vercel/analytics/vue to work without vue-router as an optional dependency

export function useRoute() {
  return {
    path: '/',
    fullPath: '/',
    name: undefined,
    params: {},
    query: {},
    hash: '',
    matched: [],
    redirectedFrom: undefined,
    meta: {},
  }
}

export function useRouter() {
  return {
    currentRoute: { value: useRoute() },
    push: () => Promise.resolve(),
    replace: () => Promise.resolve(),
    go: () => {},
    back: () => {},
    forward: () => {},
  }
}
