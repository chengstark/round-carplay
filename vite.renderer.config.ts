import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(__dirname, 'src/renderer/public'),
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@carplay/web': resolve(__dirname, 'src/renderer/components/web/CarplayWeb.ts'),
      '@carplay/messages': resolve(__dirname, 'src/main/carplay/messages'),
      '@carplay': resolve(__dirname, 'src/main/carplay'),
      stream: 'stream-browserify',
      Buffer: 'buffer'
    }
  },
  optimizeDeps: {
    exclude: ['audio.worklet.js'],
    esbuildOptions: {
      define: { global: 'globalThis' },
      plugins: [NodeGlobalsPolyfillPlugin({ process: true, buffer: true })]
    }
  },
  plugins: [react()],
  worker: { format: 'es' }
})
