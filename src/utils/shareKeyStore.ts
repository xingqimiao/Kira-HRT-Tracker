import { get, remove, set } from './secureStore';

/**
 * Where a live share's link key is kept.
 *
 * A sealed share is written with a key that only ever existed in the URL handed to the
 * recipient. Updating a *live* link later means sealing the new snapshot with that same
 * key — so the device that created it has to remember it. This is the only reason the
 * key is stored at all, and it is stored through `secureStore` (encrypted on Android,
 * the boot-shell rules apply) rather than anywhere the server could read, which is the
 * whole point of sealing.
 *
 * A frozen link needs none of this: it is written once and its key is never used again.
 */
const KEY_PREFIX = 'hrt-share-key-';
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export async function rememberShareKey(shareId: string, key: string): Promise<void> {
    if (!KEY_SHAPE.test(key)) return;
    try {
        set(`${KEY_PREFIX}${shareId}`, key);
    } catch {
        // Private mode / storage disabled: the current tab can still update the link,
        // and the next page load simply has no key to seal with.
    }
}

/** A remembered key, or null. Never throws — a missing key is a normal state. */
export async function recallShareKey(shareId: string): Promise<string | null> {
    try {
        const value = get(`${KEY_PREFIX}${shareId}`);
        return value && KEY_SHAPE.test(value) ? value : null;
    } catch {
        return null;
    }
}

/** Drop a key when its link is revoked. */
export async function forgetShareKey(shareId: string): Promise<void> {
    try {
        remove(`${KEY_PREFIX}${shareId}`);
    } catch {
        // Nothing to do: an orphaned key is inert once the share row is gone.
    }
}
