import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'

const alias = {
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@carplay/web': resolve(__dirname, 'src/renderer/components/web/CarplayWeb.ts'),
  '@carplay/messages': resolve(__dirname, 'src/main/carplay/messages'),
  '@carplay': resolve(__dirname, 'src/main/carplay'),
  stream: 'stream-browserify',
  Buffer: 'buffer'
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({})],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/main/index.ts'),
          backend: resolve(__dirname, 'src/backend/index.ts'),
          usbWorker: resolve(__dirname, 'src/main/usb/USBWorker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    },
    resolve: {
      alias
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({})],
    build: {
      outDir: 'out/preload'
    },
    resolve: {
      alias
    }
  },
  renderer: {
    base: './',
    publicDir: resolve(__dirname, 'src/renderer/public'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        },
        output: {
          // Content hashes are required here: browser releases share one
          // localhost origin, so a fixed index.js/index.css can survive an OTA
          // activation in Chromium's cache and keep running the old UI.
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]'
        }
      }
    },
    resolve: {
      alias
    },
    optimizeDeps: {
      exclude: ['audio.worklet.js'],
      esbuildOptions: {
        define: { global: 'globalThis' },
        plugins: [NodeGlobalsPolyfillPlugin({ process: true, buffer: true })]
      }
    },
    plugins: [react({})],
    server: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-site'
      }
    },
    worker: {
      format: 'es'
    }
  }
})
