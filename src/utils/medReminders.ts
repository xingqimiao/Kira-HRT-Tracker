import {
    cancelAll,
    createChannel,
    Importance,
    isPermissionGranted,
    requestPermission,
    Schedule,
    sendNotification,
} from '@choochmeque/tauri-plugin-notifications-api';
import { get, set } from './secureStore';
import { isNativeApp } from './platform';

export interface MedReminder {
    id: string;
    name: string;
    hour: number;
    minute: number;
    enabled: boolean;
}

export const MED_REMINDERS_KEY = 'hrt-med-reminders';

export function sanitizeMedReminders(value: unknown): MedReminder[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const r = item as Partial<MedReminder>;
        if (typeof r.id !== 'string' || typeof r.name !== 'string') return [];
        const hour = Number(r.hour), minute = Number(r.minute);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return [];
        return [{ id: r.id, name: r.name.trim().slice(0, 80) || 'HRT', hour, minute, enabled: r.enabled !== false }];
    });
}

export function readMedReminders(): MedReminder[] {
    try { return sanitizeMedReminders(JSON.parse(get(MED_REMINDERS_KEY) ?? '[]')); } catch { return []; }
}

export function writeMedReminders(reminders: MedReminder[]): void {
    set(MED_REMINDERS_KEY, JSON.stringify(sanitizeMedReminders(reminders)));
}

export function nextOccurrenceOf(hour: number, minute: number, now = new Date()): Date {
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
}

function stableIntId(id: string): number {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
    return (hash >>> 0) & 0x7fffffff;
}

export async function rescheduleAllNativeNotifications(request = false): Promise<boolean> {
    if (!isNativeApp()) return false;
    let granted = await isPermissionGranted();
    if (!granted && request) granted = (await requestPermission()) === 'granted';
    if (!granted) return false;
    await createChannel({ id: 'hrt-med', name: 'HRT medication', importance: Importance.Default, vibration: true });
    await cancelAll();
    for (const reminder of readMedReminders()) {
        if (!reminder.enabled) continue;
        await sendNotification({
            id: stableIntId(reminder.id),
            title: reminder.name,
            body: 'Medication reminder',
            channelId: 'hrt-med',
            // DateMatch survives reboot and recalculates in the current timezone/DST.
            schedule: Schedule.interval({ hour: reminder.hour, minute: reminder.minute }, true),
        });
    }
    return true;
}
