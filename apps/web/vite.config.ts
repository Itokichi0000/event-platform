import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API = process.env.KAMEN_API_URL ?? 'http://localhost:8787';
// Keep the browser's Host header: NIP-98 auth checks the signed URL against it.
const proxy = { '/api': { target: API, changeOrigin: false } };
// Same CSP as deploy/Caddyfile, so `vite preview` (and the E2E tests) catch violations.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Kamen — 匿名イベントチケット',
        short_name: 'Kamen',
        description: '身元を明かさずにイベントへ参加できるチケット',
        lang: 'ja',
        start_url: '/tickets',
        scope: '/',
        display: 'standalone',
        background_color: '#09090b',
        theme_color: '#09090b',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is precached so "my tickets" opens offline; tickets live in IndexedDB.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // API responses are never cached by the service worker.
        runtimeCaching: [],
      },
    }),
  ],
  server: { proxy },
  preview: { proxy, headers: { 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' } },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // The marmot-ts chunk (~550 KB, ~155 KB gzip) is loaded only when a room is opened.
    chunkSizeWarningLimit: 600,
    sourcemap: false,
  },
});
