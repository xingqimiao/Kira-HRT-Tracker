/**
 * The public thank-you list, read and applied to from the donation page.
 *
 * Both calls are unauthenticated by design: the list is public, and an application
 * is a claim that does not become visible until a person has checked it. The
 * server is still the authority on what is valid; `supporterValidation` is used
 * here only to give the form an immediate answer.
 */
import { apiEndpoint, apiFetch } from './apiClient';

export interface Supporter {
    id: string;
    name: string;
    source: 'bmc' | 'crypto' | 'afdian';
    at: string;
}

export type ApplyErrorCode =
    | 'INVALID_NAME'
    | 'INVALID_TX_HASH'
    | 'DUPLICATE_TX'
    | 'RATE_LIMITED'
    | 'TURNSTILE'
    | 'NOT_FOUND'
    | 'UNCONFIRMED'
    | 'NOT_RECEIVED'
    | 'VERIFY_UNAVAILABLE'
    | 'NETWORK';

export type ApplyResult = { ok: true } | { ok: false; code: ApplyErrorCode };

export async function fetchSupporters(): Promise<Supporter[]> {
    const response = await apiFetch(apiEndpoint('/api/supporters'), {
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`supporters: ${response.status}`);
    const body = (await response.json()) as { supporters?: unknown };
    if (!Array.isArray(body.supporters)) return [];
    return body.supporters.filter((row): row is Supporter =>
        !!row && typeof row === 'object'
        && typeof (row as Supporter).id === 'string'
        && typeof (row as Supporter).name === 'string'
        && ((row as Supporter).source === 'bmc' || (row as Supporter).source === 'crypto' || (row as Supporter).source === 'afdian'),
    );
}

export async function applyForSupporter(
    txHash: string,
    name: string,
    turnstileToken: string,
): Promise<ApplyResult> {
    let response: Response;
    try {
        response = await apiFetch(apiEndpoint('/api/supporters/apply'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txHash, name, turnstileToken }),
        });
    } catch {
        return { ok: false, code: 'NETWORK' };
    }
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    const known: ApplyErrorCode[] = [
        'INVALID_NAME', 'INVALID_TX_HASH', 'DUPLICATE_TX', 'RATE_LIMITED', 'TURNSTILE',
        'NOT_FOUND', 'UNCONFIRMED', 'NOT_RECEIVED', 'VERIFY_UNAVAILABLE',
    ];
    if (known.includes(code as ApplyErrorCode)) return { ok: false, code: code as ApplyErrorCode };
    return { ok: false, code: 'NETWORK' };
}
