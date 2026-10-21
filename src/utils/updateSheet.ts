import { useEffect, useState } from 'react';
import type { NativeUpdate } from './nativeUpdate';

/**
 * Which update, if any, the sheet is currently showing.
 *
 * A module-level store rather than props because two unrelated places open the same
 * sheet: `UpdateNotice` when it discovers a new build in the background, and the
 * settings item when the user asks to check. Sharing one piece of state is what makes
 * "check for updates" put the user *in* the update flow — progress included — instead
 * of answering with a text dialog that starts a download the user cannot see.
 */
let current: NativeUpdate | null = null;
const listeners = new Set<(update: NativeUpdate | null) => void>();

export function openUpdateSheet(update: NativeUpdate): void {
    current = update;
    for (const listener of listeners) listener(current);
}

export function closeUpdateSheet(): void {
    current = null;
    for (const listener of listeners) listener(current);
}

export function useUpdateSheet(): NativeUpdate | null {
    const [value, setValue] = useState<NativeUpdate | null>(current);
    useEffect(() => {
        const listener = (next: NativeUpdate | null) => setValue(next);
        listeners.add(listener);
        // The store may have changed between render and subscribe.
        setValue(current);
        return () => {
            listeners.delete(listener);
        };
    }, []);
    return value;
}
