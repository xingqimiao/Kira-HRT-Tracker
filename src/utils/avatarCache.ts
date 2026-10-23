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
 * Keyed by the caller's own scope, not by device: two accounts on one browser
 * must never see each other's picture, even for a frame. The account page scopes
 * by username; the security page scopes by `userId:provider`, because one person
 * has a different picture on X and on Google. Refresh happens in the background
 * on every page load — a conditional-GET against our own copy — so a changed
 * provider picture swaps in without ever blanking the avatar.
 */

const keyFor = (cacheKey: string): string => `avatar-cache-v1:${cacheKey}`;

export interface CachedAvatar {
    url: string;
    dataUrl: string;
}

export function getCachedAvatar(cacheKey: string): CachedAvatar | null {
    try {
        const raw = secureGet(keyFor(cacheKey));
        return raw ? (JSON.parse(raw) as CachedAvatar) : null;
    } catch {
        return null;
    }
}

function store(cacheKey: string, avatar: CachedAvatar): void {
    try {
        secureSet(keyFor(cacheKey), JSON.stringify(avatar));
    } catch {
        // Quota is best-effort: an uncached avatar paints the old way.
    }
}

export function clearCachedAvatar(cacheKey: string): void {
    try {
        secureRemove(keyFor(cacheKey));
    } catch {
        // Nothing to clear is fine.
    }
}

/**
 * Fetch the avatar image and cache it as a data URL. The conditional-GET means an
 * unchanged picture is answered from the browser's own cache; a changed one swaps
 * into the cache and the caller's state.
 */
export async function refreshCachedAvatar(cacheKey: string, url: string): Promise<string | null> {
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
        store(cacheKey, { url, dataUrl });
        return dataUrl;
    } catch {
        return null;
    }
}
