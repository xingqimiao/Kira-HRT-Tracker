const UNRECOVERABLE_KEY_ERROR_RE = /AEADBadTagException|BadPaddingException|IllegalBlockSizeException|KeyPermanentlyInvalidatedException|UnrecoverableKeyException|InvalidKeyException|InvalidAlgorithmParameterException|invalidData|invalid format/i;

/** Whether an error from `secureStorage` indicates an unrecoverable Keystore/DataStore mismatch. */
export const isUnrecoverableKeyError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return UNRECOVERABLE_KEY_ERROR_RE.test(message);
};

/** Whether a base64 string decodes to a valid 256-bit AES-GCM raw key. */
export const isValidRawKeyBase64 = (value: string): boolean => {
    if (!value) return false;
    try {
        const raw = atob(value);
        return raw.length === 32;
    } catch {
        return false;
    }
};

export interface RecordKeyDeps {
    getItem: () => Promise<string | null>;
    setItem: (value: string) => Promise<void>;
    removeItem: () => Promise<void>;
    resetAlias: () => void;
    generateKey: () => string;
    hasProtectedLocalData: () => boolean;
    sleep: (ms: number) => Promise<void>;
}

/**
 * Resolve the device's 32-byte record key, recovering from missing keys or
 * permanent Keystore/DataStore mismatches without overwriting on transient errors.
 */
export async function resolveRecordKey(deps: RecordKeyDeps): Promise<{ key: string; recovered: boolean }> {
    let stored: string | null = null;
    let unreadableKey = false;

    for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt > 0) await deps.sleep(200);
        try {
            const candidate = await deps.getItem();
            if (candidate) {
                if (isValidRawKeyBase64(candidate)) {
                    return { key: candidate, recovered: false };
                }
                unreadableKey = true;
                break;
            }
            stored = null;
        } catch (err) {
            if (isUnrecoverableKeyError(err)) {
                // One confirmation retry in case the Keystore HAL had a momentary hiccup.
                if (attempt === 0) continue;
                unreadableKey = true;
                break;
            }
            if (attempt === 3) throw err;
        }
    }

    const hadData = deps.hasProtectedLocalData();
    if (unreadableKey) {
        try {
            await deps.removeItem();
        } catch {
            // Best-effort: `setItem` overwrites the entry next.
        }
    }

    const generated = deps.generateKey();
    try {
        await deps.setItem(generated);
    } catch (writeErr) {
        if (!isUnrecoverableKeyError(writeErr)) throw writeErr;
        try { deps.resetAlias(); } catch { /* best-effort */ }
        try { await deps.removeItem(); } catch { /* best-effort */ }
        await deps.setItem(generated);
    }

    const check = await deps.getItem();
    if (check !== generated) {
        throw new Error('secure store key was not persisted');
    }
    return { key: generated, recovered: !stored && hadData };
}
