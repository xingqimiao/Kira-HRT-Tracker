import path from 'path';
import { execSync } from 'node:child_process';
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

/**
 * A short stamp that changes whenever the code does, used to version the service
 * worker's filename.
 *
 * A fixed `/sw.js` is un-propagatable in a way that produced a real bug. Cloudflare's
 * default Browser Cache TTL (4 hours) pinned that file at the edge, so its bytes never
 * changed, so the browser's update check concluded "no new version" — and the
 * *previous* worker kept serving its old precache manifest. The new `index.html`
 * pointed at a new bundle and it made no difference, because the request never reached
 * the network. A fixed bug stayed broken for the person who reported it.
 *
 * A different URL whenever the commit changes sidesteps the whole class: there is
 * nothing cached to serve, so the new worker installs, claims the scope and replaces
 * the old one. The Caddy `no-cache` header on `/sw*.js` covers the case where a URL is
 * somehow revisited. Both, because either alone leaves a window.
 *
 * Falls back to the app version when git is unavailable (a tarball build), which is
 * coarser but still changes when the project does.
 */
function swStamp(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return pkg.version;
  }
}

const SW_FILENAME = `sw-${swStamp()}.js`;

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
        // The worker gets a commit-stamped name so a deploy is never shadowed by a
        // cached copy at a fixed path — see `swStamp`.
        filename: SW_FILENAME,
        // Registering inline puts the code in `index.html`, which is served
        // `DYNAMIC` by Cloudflare and therefore never edge-cached. An external
        // `/registerSW.js` would be one more fixed URL to go stale.
        injectRegister: 'inline',
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
              //
              // That held only while the file existed. Caddy's SPA fallback
              // (`try_files {path} /index.html`) answers a *missing* `/ocr/*` path
              // with the shell — a 200 `text/html` — and `statuses: [0, 200]` cannot
              // tell the shell from the asset, so CacheFirst stored the shell and
              // served it for a year. tesseract.js wrote that HTML as
              // `chi_sim.traineddata`, initialised without the Chinese model, and
              // every later scan read the label as noise and reported "no usable
              // values" — surviving the deploy that shipped the real file, because a
              // runtime cache is not invalidated by a new service worker.
              //
              // Two changes, and both are needed. The cache *name* is bumped so no
              // client reads an entry an earlier deploy poisoned: a runtime cache
              // outlives the worker that wrote it and `cleanupOutdatedCaches` only
              // touches the precache, so replacing the file cannot heal it. And the
              // plugin refuses to store an HTML response at all, so the hole cannot
              // reopen if a wrong path is answered with 200 again.
              urlPattern: /\/ocr\/.*\.(?:js|wasm|gz)$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'ocr-assets-v2',
                expiration: {
                  // A handful of files, but the variants are per-feature-detection
                  // so only one or two will ever be fetched by a given device.
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: { statuses: [0, 200] },
                plugins: [
                  {
                    // A 200 is not enough — the SPA shell is a 200 too.
                    cacheWillUpdate: async ({ response }: { response: Response }) => {
                      const type = response?.headers.get('content-type') ?? '';
                      return /text\/html/i.test(type) ? null : response;
                    },
                  },
                ],
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
