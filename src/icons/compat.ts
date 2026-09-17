/**
 * Icon fallbacks for the handful of glyphs this app needs that `reicon` does not
 * ship. Each entry is the same `{ O }` shape reicon's own `createIcon` consumes.
 *
 * lucide draws with strokes and reicon fills its own shapes, so every glyph here
 * is wrapped in a `stroke="currentColor"` group — without it `createIcon`'s bare
 * `fill="none"` leaves the path with no paint and the icon is invisible. See the
 * note in `scripts/gen-compat-icons.mjs` for the full story.
 *
 * Generated, then frozen — the runtime dependency is gone. Regenerate with
 * `node scripts/gen-compat-icons.mjs`.
 */
import { createIcon } from 'reicon';

export const BadgeCheck = createIcon("BadgeCheck", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"></path><path d="m9 12 2 2 4-4"></path></g>`,
});

export const BookmarkPlus = createIcon("BookmarkPlus", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path><line x1="12" x2="12" y1="7" y2="13"></line><line x1="15" x2="9" y1="10" y2="10"></line></g>`,
});

export const CheckCircle2 = createIcon("CheckCircle2", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></g>`,
});

export const CircleOff = createIcon("CircleOff", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m2 2 20 20"></path><path d="M8.35 2.69A10 10 0 0 1 21.3 15.65"></path><path d="M19.08 19.08A10 10 0 1 1 4.92 4.92"></path></g>`,
});

export const CloudOff = createIcon("CloudOff", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m2 2 20 20"></path><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"></path><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"></path></g>`,
});

export const DownloadCloud = createIcon("DownloadCloud", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M12 12v9"></path><path d="m8 17 4 4 4-4"></path></g>`,
});

export const ExternalLink = createIcon("ExternalLink", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></g>`,
});

export const Flame = createIcon("Flame", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></g>`,
});

export const FlaskConical = createIcon("FlaskConical", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"></path><path d="M8.5 2h7"></path><path d="M7 16h10"></path></g>`,
});

export const Hexagon = createIcon("Hexagon", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></g>`,
});

export const ImageOff = createIcon("ImageOff", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><line x1="2" x2="22" y1="2" y2="22"></line><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"></path><line x1="13.5" x2="6" y1="13.5" y2="21"></line><line x1="18" x2="21" y1="12" y2="15"></line><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"></path><path d="M21 15V5a2 2 0 0 0-2-2H9"></path></g>`,
});

export const Info = createIcon("Info", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></g>`,
});

export const KeyRound = createIcon("KeyRound", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"></path><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"></circle></g>`,
});

export const ListChecks = createIcon("ListChecks", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m3 17 2 2 4-4"></path><path d="m3 7 2 2 4-4"></path><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path></g>`,
});

export const ListTodo = createIcon("ListTodo", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><rect x="3" y="5" width="6" height="6" rx="1"></rect><path d="m3 17 2 2 4-4"></path><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path></g>`,
});

export const Loader2 = createIcon("Loader2", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></g>`,
});

export const LogOut = createIcon("LogOut", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" x2="9" y1="12" y2="12"></line></g>`,
});

export const Megaphone = createIcon("Megaphone", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m3 11 18-5v12L3 14v-3z"></path><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"></path></g>`,
});

export const Merge = createIcon("Merge", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m8 6 4-4 4 4"></path><path d="M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22"></path><path d="m20 22-5-5"></path></g>`,
});

export const MonitorSmartphone = createIcon("MonitorSmartphone", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"></path><path d="M10 19v-3.96 3.15"></path><path d="M7 19h5"></path><rect width="6" height="10" x="16" y="12" rx="2"></rect></g>`,
});

export const Orbit = createIcon("Orbit", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="12" cy="12" r="3"></circle><circle cx="19" cy="5" r="2"></circle><circle cx="5" cy="19" r="2"></circle><path d="M10.4 21.9a10 10 0 0 0 9.941-15.416"></path><path d="M13.5 2.1a10 10 0 0 0-9.841 15.416"></path></g>`,
});

export const RefreshCw = createIcon("RefreshCw", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></g>`,
});

export const RotateCcw = createIcon("RotateCcw", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></g>`,
});

export const Share2 = createIcon("Share2", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"></line><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"></line></g>`,
});

export const Shell = createIcon("Shell", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M14 11a2 2 0 1 1-4 0 4 4 0 0 1 8 0 6 6 0 0 1-12 0 8 8 0 0 1 16 0 10 10 0 1 1-20 0 11.93 11.93 0 0 1 2.42-7.22 2 2 0 1 1 3.16 2.44"></path></g>`,
});

export const Smartphone = createIcon("Smartphone", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"></rect><path d="M12 18h.01"></path></g>`,
});

export const Unlink = createIcon("Unlink", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"></path><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"></path><line x1="8" x2="8" y1="2" y2="5"></line><line x1="2" x2="5" y1="8" y2="8"></line><line x1="16" x2="16" y1="19" y2="22"></line><line x1="19" x2="22" y1="16" y2="16"></line></g>`,
});

export const UploadCloud = createIcon("UploadCloud", {
  O: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M12 12v9"></path><path d="m16 16-4-4-4 4"></path></g>`,
});
