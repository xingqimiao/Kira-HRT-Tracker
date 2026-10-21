/**
 * Shared rules for the public thank-you list.
 *
 * Imported by both the browser form and the server, so the message the user sees
 * before submitting cannot disagree with the check that accepts it. The server is
 * still authoritative — this is a pre-check, not a trust boundary.
 */

/** Long enough for a normal nickname, short enough not to become a billboard. */
export const SUPPORTER_NAME_MAX = 32;

/**
 * Controls, bidi overrides and zero-width characters.
 *
 * They render as nothing but make two visually identical names compare
 * differently — exactly what a public list should not carry.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g;

/**
 * A domain-looking token, used to refuse links in nicknames.
 *
 * The requirement is "not a URL", not "a legal name": a bare `example.com`, a
 * `www.` prefix or anything with a scheme counts. A short TLD allowlist keeps a
 * legitimate name that happens to contain a dot from being rejected.
 */
const URL_LIKE = /(?:https?:\/\/|www\.)|(?:\b[\p{L}\p{N}-]+\.(?:com|net|org|io|me|xyz|app|dev|co|cn|ly|to|gg|tv|so|site|link|top|cc|ru|jp|uk|de|fr|info|biz)\b)/iu;

export type SupporterNameProblem = 'invalid' | 'empty' | 'too_long' | 'link' | 'slash';

/** Strip the invisible characters and normalise, without deciding whether it is acceptable. */
export function cleanSupporterName(raw: unknown, max = SUPPORTER_NAME_MAX): string | null {
    if (typeof raw !== 'string') return null;
    const name = raw.normalize('NFKC').replace(INVISIBLE, '').trim();
    if (!name) return null;
    return [...name].slice(0, max).join('');
}

/**
 * Validate a nickname a person chose. `name` is the cleaned value either way, so a
 * form can keep what was typed and only show the problem.
 */
export function validateSupporterName(raw: unknown): { name: string; problem: SupporterNameProblem | null } {
    if (typeof raw !== 'string') return { name: '', problem: 'invalid' };
    const name = raw.normalize('NFKC').replace(INVISIBLE, '').trim();
    if (!name) return { name, problem: 'empty' };
    if ([...name].length > SUPPORTER_NAME_MAX) return { name, problem: 'too_long' };
    if (URL_LIKE.test(name)) return { name, problem: 'link' };
    if (name.includes('/')) return { name, problem: 'slash' };
    return { name, problem: null };
}

/**
 * EVM (`0x` + 32 bytes), Bitcoin/Tron (32-byte hex), Solana (base58 signature).
 *
 * A hash is not verified on-chain here; this only rejects something that cannot
 * be a transaction hash at all.
 */
export function isSupporterTxHash(raw: unknown): boolean {
    if (typeof raw !== 'string') return false;
    const tx = raw.trim();
    return /^0x[0-9a-fA-F]{64}$/.test(tx)
        || /^[0-9a-fA-F]{64}$/.test(tx)
        || /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(tx);
}
