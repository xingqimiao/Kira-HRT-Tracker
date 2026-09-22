import path from 'path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
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
const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'));

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
    return execSync('git rev-parse --short HEAD', { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return pkg.version;
  }
}

const SW_FILENAME = `sw-${swStamp()}.js`;

/**
 * Dev-only: serve the self-hosted ONNX Runtime glue when the engine imports it.
 *
 * ONNX Runtime Web does not bundle its emscripten glue; it dynamic-imports
 * 'ort-wasm-simd-threaded.mjs' from 'env.wasm.wasmPaths' at session creation
 * (see 'src/utils/ppocr.ts'). Vite wraps *any* dynamic import whose argument is
 * not a string literal with '__vite__injectQuery(url, "import")', so that module
 * is requested as '/ocr/ort-wasm-simd-threaded.mjs?import'. Vite's public-file
 * middleware deliberately skips import requests, and the transform middleware
 * then refuses the '/public' path with ERR_LOAD_PUBLIC_URL — the overlay.
 *
 * In a build there is no module graph for this URL: '/ocr/...' is just a static
 * URL that the service worker fetches on the first scan, which is why only dev
 * breaks. This plugin serves the file raw, byte-for-byte as the public middleware
 * would and as the deployed origin does, and only under 'vite dev'.
 */
function ocrOrtGlue(): Plugin {
  return {
    name: 'ocr-ort-glue',
    apply: 'serve',
    configureServer(server) {
      // Registered before Vite's own middlewares, so this sees the import request
      // that the public middleware would have passed over.
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (!pathname.startsWith('/ocr/') || !pathname.endsWith('.mjs')) return next();
        try {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.end(readFileSync(path.resolve(import.meta.dirname, 'public', pathname.slice(1))));
        } catch {
          next();
        }
      });
    },
  };
}

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
      ocrOrtGlue(),
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
          name: 'Kira HRT Tracker',
          short_name: 'Kira HRT Tracker',
          description: 'Log HRT doses and blood tests, estimate hormone levels, and connect an AI assistant over MCP.',
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
          // The OCR assets are ~23 MB and are only fetched when someone opens the
          // scan panel. Precaching them would put that download on every install —
          // including for the overwhelming majority who never scan a report — and
          // the 2 MiB default limit makes the build fail outright on them.
          //
          // Not precached does not mean not cached: the ONNX Runtime WASM runtime,
          // the two PP-OCRv6 models and the character dictionary are stable,
          // versioned paths, so the runtime cache rule below keeps them after the
          // first scan. Served from this origin either way, never a CDN.
          //
          // '**/ocr/**' is the only thing keeping them out, and it is a glob over
          // public/ — the assets are never imported by any module, so nothing else
          // would notice if they started being precached.
          //
          // The ONNX Runtime WebAssembly build is a separate case in one way only: it
          // IS imported by a module, so it lands in assets/ rather than public/ocr/,
          // and at 14 MB it exceeds the 4 MB ceiling below — which vite-plugin-pwa
          // treats as a build failure, not a warning. It is the OCR engine's runtime
          // and belongs wherever the models are: fetched on first scan, then kept by
          // the runtime cache rule. Precaching it would put 14 MB on every install.
          // The language packs are the third case, and the one that is easy to get
          // wrong: they are lazily imported, so the module graph defers them, but
          // the precache glob sees only the emitted files and pulls all five (270 KB)
          // onto every install anyway. The lazy import then saves nothing — the
          // bytes are already in the cache before any of them is asked for. They are
          // excluded here and served by the runtime rule below instead, which is
          // what makes "load one language" mean anything.
          //
          // `{a,b}` braces, not `(a|b)`: the glob is minimatch, which does not read
          // the regex alternation a POSIX-ERE habit reaches for. Written that way
          // the pattern matches nothing and fails silently — the packs stay in the
          // precache and the only symptom is a build that looks right.
          globIgnores: [
            '**/ocr/**',
            '**/ort-wasm*.wasm',
            'assets/{ja,ko,tr,yue,zh-TW}-*.js',
          ],
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
              //
              // v3 is the same bump for a different reason: the engine changed
              // completely, and none of the four new URLs collides with one of the
              // old ones. `ponytail:` the retired `ocr-assets-v2` cache is not
              // deleted — a generated service worker cannot run arbitrary cleanup
              // code, and the only other lever would be a custom worker for ~22 MB of
              // tesseract bytes that are never read again. Says the ceiling rather
              // than pretending there is none.
              urlPattern: /\/ocr\/.*\.(?:onnx|mjs|wasm|txt)$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'ocr-assets-v3',
                expiration: {
                  // Four files per deploy: the runtime glue, its binary, the
                  // detector, the recogniser and the alphabet. The ceiling is
                  // headroom for a deploy or two of overlap, not for variants.
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
            },
            {
              // Language packs, kept after the first time a reader uses them. Paired
              // with the globIgnores entry above: without that, these five files are
              // precached and this rule never runs.
              //
              // CacheFirst, not StaleWhileRevalidate: the filename carries a content
              // hash, so a pack whose bytes changed has a different URL and a cached
              // copy can never be stale — there is nothing to revalidate. It also
              // keeps a language switch working offline, where a revalidate would
              // leave the reader on the fallback for a pack already on disk.
              //
              // The HTML guard is the same one the OCR rule carries and for the same
              // reason: Caddy's SPA fallback answers a missing asset path with a 200
              // `text/html`, and a 200-only check would cache the app shell as a
              // language pack. The reader would get the shell's markup as their
              // interface copy and never recover, because a runtime cache outlives
              // the worker that wrote it.
              urlPattern: /\/assets\/(?:ja|ko|tr|yue|zh-TW)-[A-Za-z0-9_-]+\.js$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'i18n-packs-v1',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: { statuses: [0, 200] },
                plugins: [
                  {
                    cacheWillUpdate: async ({ response }: { response: Response }) => {
                      const type = response?.headers.get('content-type') ?? '';
                      return /text\/html/i.test(type) ? null : response;
                    },
                  },
                ],
              },
            }
          ]
        }
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      }
    }
  };
});
