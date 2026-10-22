import { DoseEvent, HRTMode, SimulationResult } from '../../logic';
import { apiEndpoint, apiFetch } from './apiClient';
import {
    createShareKey,
    sealShareSnapshot,
    withShareKey,
    type SealedSnapshot,
} from '../utils/shareCrypto';
import { forgetShareKey, recallShareKey, rememberShareKey } from '../utils/shareKeyStore';

export interface SharedDosageSnapshot {
    version: 1;
    mode: HRTMode;
    timezone: string;
    createdAt: number;
    events: DoseEvent[];
    simulation: SimulationResult | null;
}

export interface ShareDetails {
    passwordRequired: boolean;
    live: boolean;
    createdAt: number;
    updatedAt: number;
    expiresAt: number | null;
    /**
     * The snapshot, present only for a link written before snapshots were sealed (and
     * for one an agent created server-side, which is plaintext by construction). A
     * sealed link carries `sealed` instead — see `src/utils/shareCrypto.ts`.
     */
    snapshot: SharedDosageSnapshot | null;
    /** The opaque envelope a client-sealed link carries. Opened in the browser. */
    sealed?: SealedSnapshot;
    /** The link's mode, without opening anything. */
    mode: HRTMode | null;
    /** Short-lived signed pass returned after a successful password unlock. */
    viewerPass?: string;
}

export interface CreatedShare {
    id: string;
    token: string;
    url: string;
    createdAt: number;
    expiresAt: number | null;
    passwordRequired: boolean;
    live: boolean;
    mode: HRTMode;
    updatedAt: number;
}

export interface LockedShare {
    passwordRequired: true;
    live: boolean;
    createdAt: number;
    updatedAt: number;
    expiresAt: number | null;
}

export interface ShareSummary {
    id: string;
    createdAt: number;
    expiresAt: number | null;
    passwordRequired: boolean;
    live: boolean;
    mode: HRTMode | null;
    updatedAt: number;
    expired: boolean;
    /** Present when the link is sealed; absent for a pre-sealing (plaintext) one. */
    sealed?: SealedSnapshot;
}

export class ShareApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly retryAfterMs: number | null = null,
    ) {
        super(message);
        this.name = 'ShareApiError';
    }
}

/**
 * The share link as a person can use it.
 *
 * The Core answers with a path (`/share/<token>`) because it does not know which
 * origin the app is served from — but a path copied into a chat is a dead link.
 * Resolve it against the deployment's public origin: `VITE_PUBLIC_ORIGIN` where
 * the build sets one (the Android/webview build does), the current origin
 * otherwise (same-origin web builds and the dev server).
 */
const PUBLIC_ORIGIN = (() => {
    // Same cast as apiClient: `import.meta.env` is Vite-only, and this module is
    // also loaded by plain-Node scripts.
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const configured = env?.VITE_PUBLIC_ORIGIN?.trim();
    if (configured) return configured.replace(/\/+$/, '');
    return typeof window !== 'undefined' ? window.location.origin : '';
})();

export const absoluteShareUrl = (url: string): string => {
    if (!PUBLIC_ORIGIN) return url;
    try {
        return new URL(url, PUBLIC_ORIGIN).href;
    } catch {
        return url;
    }
};

const readError = async (response: Response): Promise<ShareApiError> => {
    let body: { code?: string; message?: string; retryAfterSeconds?: number } | null = null;
    try {
        body = await response.json() as { code?: string; message?: string; retryAfterSeconds?: number };
    } catch {
        // The worker also has plain-text error responses outside share routes.
    }
    const headerSeconds = Number(response.headers.get('Retry-After'));
    const seconds = Number.isFinite(headerSeconds) && headerSeconds > 0
        ? headerSeconds
        : body?.retryAfterSeconds;
    return new ShareApiError(
        response.status,
        body?.code ?? 'SHARE_REQUEST_FAILED',
        body?.message ?? `Share request failed (${response.status})`,
        typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
            ? seconds * 1_000
            : null,
    );
};

export const sharingService = {
    /**
     * Create a link from a snapshot the browser seals itself.
     *
     * The key is generated here, never sent, and returned only inside the URL — so the
     * server stores an envelope it cannot open. `mode` is the one field that travels in
     * the clear beside it: the owner's own list needs it without a key, and the live
     * sync uses it to find the right link.
     *
     * There is no plaintext fallback. It once existed for servers that predated
     * sealed shares, keyed on a 5xx — which meant a database blip or a KMS outage
     * silently published readable health data and handed back a key-less URL. Any
     * failure is surfaced, and the caller retries the same sealed request.
     */
    async create(
        authToken: string,
        snapshot: SharedDosageSnapshot,
        options: { password?: string; expiresAt: number; live?: boolean },
    ): Promise<CreatedShare> {
        const key = createShareKey();
        const sealed = await sealShareSnapshot(snapshot, key);
        const live = options.live ?? false;
        const post = (body: Record<string, unknown>) => apiFetch(apiEndpoint('/api/shares'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const common = {
            password: options.password || undefined,
            expiresAt: options.expiresAt,
            live,
        };

        // One attempt, sealed. There used to be a fallback that retried with the
        // plaintext snapshot whenever this failed with a 5xx — a "compatibility" path
        // for servers that did not understand `sealed`. The effect was that a
        // database blip, a KMS hiccup or a 502 made the app quietly upload readable
        // health data and hand back a URL with no key, while the user believed only
        // they could open the link. Capability negotiation happened nowhere; a 5xx is
        // not a statement about the API version. Every server this app talks to has
        // supported sealed shares since 2.0.
        const response = await post({ sealed, mode: snapshot.mode, ...common });
        if (!response.ok) throw await readError(response);
        const created = await response.json() as CreatedShare;
        // A live link is rewritten by this device later, so its key has to survive a
        // reload. A frozen one is written once and never needs it again.
        if (live) await rememberShareKey(created.id, key);
        return { ...created, url: withShareKey(absoluteShareUrl(created.url), key) };
    },

    async open(token: string, viewerPass?: string): Promise<ShareDetails | LockedShare> {
        const response = await fetch(apiEndpoint('/api/shares/access'), {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            cache: 'no-store',
            body: JSON.stringify({ token, viewerPass }),
        });
        if (response.status === 401) {
            const body = await response.json() as LockedShare & { code?: string };
            if (body.code === 'PASSWORD_REQUIRED' || body.passwordRequired) return body;
        }
        if (!response.ok) throw await readError(response);
        return await response.json() as ShareDetails;
    },

    async unlock(token: string, password?: string, viewerPass?: string): Promise<ShareDetails> {
        const response = await fetch(apiEndpoint('/api/shares/access'), {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            cache: 'no-store',
            body: JSON.stringify({ token, password, viewerPass }),
        });
        if (!response.ok) throw await readError(response);
        return await response.json() as ShareDetails;
    },

    async list(authToken: string): Promise<ShareSummary[]> {
        const response = await apiFetch(apiEndpoint('/api/shares'), {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Accept': 'application/json',
            },
            cache: 'no-store',
        });
        if (!response.ok) throw await readError(response);
        const body = await response.json() as { shares: ShareSummary[] };
        return body.shares;
    },

    /**
     * Refresh one live link's snapshot.
     *
     * Per link, not for all of them at once: each link has its own key, so one snapshot
     * becomes one envelope per link.
     *
     * Two fallbacks, both deliberate:
     *
     *   - **No key on this device** (another device created the link, or storage was
     *     cleared): send nothing. Sealing is impossible and plaintext would defeat it.
     *   - **A link written before sealing** has no envelope and no remembered key. It
     *     falls back to the older plaintext refresh, which the server restricts to rows
     *     that are *not* sealed — so a live link from 1.2.3 keeps updating instead of
     *     silently freezing, and nothing sealed is ever overwritten.
     */
    async syncLive(
        authToken: string,
        share: { id: string; snapshot: SharedDosageSnapshot; legacy?: boolean },
        signal?: AbortSignal,
    ): Promise<{ updated: number; updatedAt: number }> {
        const key = await recallShareKey(share.id);
        // No key and a sealed link: send nothing. Only a link written before sealing
        // can be refreshed in the clear — the server refuses to put plaintext over an
        // envelope, and this client should not send it in the first place.
        if (!key && !share.legacy) return { updated: 0, updatedAt: Date.now() };
        const response = await apiFetch(apiEndpoint('/api/shares/live'), {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(key
                ? { shareId: share.id, sealed: await sealShareSnapshot(share.snapshot, key), mode: share.snapshot.mode }
                : { snapshot: share.snapshot }),
            signal,
        });
        if (!response.ok) throw await readError(response);
        return await response.json() as { updated: number; updatedAt: number };
    },

    async revoke(authToken: string, shareId: string): Promise<void> {
        const response = await apiFetch(apiEndpoint(`/api/shares/${encodeURIComponent(shareId)}`), {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` },
        });
        if (!response.ok) throw await readError(response);
        await forgetShareKey(shareId);
    },
};

export const LIVE_SHARES_CHANGED_EVENT = 'hrt-live-shares-changed';

export const notifyLiveSharesChanged = (): void => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(LIVE_SHARES_CHANGED_EVENT));
};
