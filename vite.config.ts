import path from 'path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The version shown in Settings → About, taken from `package.json` at build time.
 *
 * It used to be a second hardcoded literal (`"Stable 1.4.0"`) next to the one in
 * `package.json`, which is the arrangement that guarantees the two disagree the
 * first time someone bumps one of them. One source now.
 *
 * The `Stable ` prefix is gone with it: that was a mobile-store channel label
 * carried over from the upstream project, and this app has no beta/stable split to
 * distinguish — a version that names a channel nobody can switch to is a claim that
 * is not about anything.
 */
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig(() => {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
          secure: false,
        }
      }
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.png', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
        manifest: {
          name: 'Kira Tracker',
          short_name: 'Kira Tracker',
          description: 'Track your HRT dosage and simulate E2 levels',
          theme_color: '#FAF9F7',
          background_color: '#FAF9F7',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any maskable'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        },
        workbox: {
          // Shared pages require the network API and should always load the
          // current application shell instead of an older precached shell.
          navigateFallbackDenylist: [/^\/share(?:\/|$)/],
          // The OCR assets are ~22 MB and are only fetched when someone opens the
          // scan panel. Precaching them would put that download on every install —
          // including for the overwhelming majority who never scan a report — and
          // the 2 MiB default limit makes the build fail outright on them.
          //
          // Not precached does not mean not cached: the worker script, the WASM core
          // and the trained data are stable, versioned paths, so the runtime cache
          // rule below keeps them after the first scan. Served from this origin
          // either way, never a CDN.
          globIgnores: ['**/ocr/**'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          runtimeCaching: [
            {
              // The OCR assets, cached on first use. CacheFirst because they are
              // content-addressed by version in the path — the URL changes when the
              // version does, so a cached copy can never be stale.
              urlPattern: /\/ocr\/.*\.(?:js|wasm|gz)$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'ocr-assets',
                expiration: {
                  // A handful of files, but the variants are per-feature-detection
                  // so only one or two will ever be fetched by a given device.
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/cdn\.tailwindcss\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'tailwindcss-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365 // <== 365 days
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            }
          ]
        }
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
