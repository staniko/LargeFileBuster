import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: path.resolve(__dirname, 'src', 'renderer'),
  publicDir: path.resolve(__dirname, 'public'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist', 'renderer'),
    emptyOutDir: true,
    target: 'es2020'
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src', 'renderer'),
      '@main': path.resolve(__dirname, 'src', 'main'),
      '@shared': path.resolve(__dirname, 'src', 'shared')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
