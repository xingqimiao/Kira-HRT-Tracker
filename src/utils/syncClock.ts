import { get, set } from './secureStore';

const offsetKey = 'hrt-server-clock-offset';
let clockOffsetMs: number | undefined;

export function observeServerClock(value: string | null, receivedAt = Date.now()): void {
    if (!value || !/^\d{13}$/.test(value)) return;
    clockOffsetMs = Number(value) - receivedAt;
    try { set(offsetKey, String(clockOffsetMs)); } catch { /* Keep the in-memory sample. */ }
}

export function syncTimestamp(): number {
    if (clockOffsetMs === undefined) {
        try {
            const saved = get(offsetKey);
            if (saved !== null && Number.isFinite(Number(saved))) clockOffsetMs = Number(saved);
        } catch { /* Storage can be unavailable. */ }
    }
    return Date.now() + (clockOffsetMs ?? 0);
}
