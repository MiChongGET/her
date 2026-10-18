import { defineConfig } from 'electron-vite'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(16).toString('base64') : undefined
  return {
    main: {},
    preload: {
      build: {
        rollupOptions: {
          input: {index: resolve('src/preload/index.ts'), pdf: resolve('src/preload/pdf.ts')},
          output: { format: 'cjs', entryFileNames: '[name].cjs' }
        }
      }
    },
    renderer: {
      html: { cspNonce: nonce },
      build: { rollupOptions: {input: {index:resolve('src/renderer/index.html'),pdf:resolve('src/renderer/pdf/index.html')}} },
      plugins: [
        react(),
        {
          name: 'her-local-pdf-assets',
          async configureServer() {
            // The PDF sandbox always loads compiled local assets, including in dev.
            await build({configFile:false,root:resolve('src/renderer'),build:{outDir:resolve('out/renderer'),emptyOutDir:false,rollupOptions:{input:{pdf:resolve('src/renderer/pdf/index.html')}}}})
            copyPdfAssets()
          },
          closeBundle: copyPdfAssets
        },
        {
          name: 'her-development-csp',
          apply: 'serve',
          transformIndexHtml(html) {
            return html
              .replace("script-src 'self'", "script-src 'self' 'nonce-" + nonce + "'")
              .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*")
          }
        }
      ]
    }
  }
})

function copyPdfAssets(): void {
  const target = resolve('out/renderer/assets/pdfjs')
  mkdirSync(join(target, 'build'), { recursive: true })
  for (const entry of ['build/pdf.mjs','build/pdf.worker.mjs','cmaps','standard_fonts','wasm','iccs','LICENSE','package.json']) {
    cpSync(resolve('node_modules/pdfjs-dist', entry), join(target, entry), { recursive: true })
  }
}
