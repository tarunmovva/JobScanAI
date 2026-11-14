import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  main: {
    build: {
      lib: { entry: 'electron/main.ts' }
    }
  },
  preload: {
    build: {
      lib: { entry: 'electron/preload.ts' }
    }
  },
  renderer: {
    root: 'src',
    build: {
      // No data: URIs — CSP is default-src 'self', so inlined fonts would be
      // refused. Emit every asset as a real file instead.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: path.resolve(__dirname, 'src/index.html')
      }
    },
    plugins: [react()],
  }
})
