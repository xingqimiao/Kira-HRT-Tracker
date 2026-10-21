import { get as secureGet, set as secureSet, remove as secureRemove } from './secureStore';
/**
 * The account avatar, cached on the device as a data URL.
 *
 * Why: the account page renders its text as soon as the summary lands, but the
 * picture used to arrive a beat later — a fresh <img> mounting after the first
 * paint, revalidating against the API every time. To the eye that is a flash:
 * the identity block paints twice. A data URL in localStorage paints with the
 * first render, on the same frame as the text, with no request at all.
 *
 * Keyed by username, not by device: two accounts on one browser must never see
 * each other's picture, even for a frame. Refresh happens in the background on
 * every page load — a conditional-GET against our own copy — so a changed
 * provider picture swaps in without ever blanking the avatar.
 */

const keyFor = (username: string): string => `avatar-cache-v1:${username}`;

export interface CachedAvatar {
  url: string;
  dataUrl: string;
}

export function getCachedAvatar(username: string): CachedAvatar | null {
  try {
    const raw = secureGet(keyFor(username));
    return raw ? (JSON.parse(raw) as CachedAvatar) : null;
  } catch {
    return null;
  }
}

function store(username: string, avatar: CachedAvatar): void {
  try {
    secureSet(keyFor(username), JSON.stringify(avatar));
  } catch {
    // Quota is best-effort: an uncached avatar paints the old way.
  }
}

export function clearCachedAvatar(username: string): void {
  try {
    secureRemove(keyFor(username));
  } catch {
    // Nothing to clear is fine.
  }
}

/**
 * Fetch the avatar image and cache it as a data URL. The conditional-GET means an
 * unchanged picture is answered from the browser's own cache; a changed one swaps
 * into the cache and the caller's state.
 */
export async function refreshCachedAvatar(username: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 512 * 1024) return null; // above the display size we ship; skip caching
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    store(username, { url, dataUrl });
    return dataUrl;
  } catch {
    return null;
  }
}
