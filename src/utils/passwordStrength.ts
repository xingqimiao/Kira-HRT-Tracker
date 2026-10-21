/**
 * Password strength and entropy estimator.
 *
 * Dependency-free estimator shared between the frontend (for visual entropy meter
 * and input validation) and the server (for enforcing a minimum 40-bit entropy floor
 * on share creation and password settings).
 *
 * It prevents obvious passwords: dates, common words, keyboard walks, repeated characters,
 * or leet-speak substitutions of known words.
 */

export type PasswordStrength = 'weak' | 'fair' | 'strong';

/** Shortest password accepted for an account or share. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** Below this many estimated bits a password is refused. */
export const WEAK_BITS = 40;
/** At or above this many estimated bits a password reads as strong. */
export const STRONG_BITS = 60;

/** Character classes for charset analysis. */
export interface PasswordCharset {
    lower: boolean;
    upper: boolean;
    digits: boolean;
    symbols: boolean;
    nonAscii: boolean;
}

const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const DIGITS = /[0-9]/;
const SYMBOLS = /[!-/:-@[-`{-~ ]/;
const NON_ASCII = /[^\x20-\x7e]/;

/** Common passwords, leaked phrases, and frequent Chinese pinyin combinations. */
const COMMON = new Set([
    'password',
    'passw0rd',
    'p@ssw0rd',
    'iloveyou',
    'woaini',
    'woaiwojia',
    'aini',
    'qwerty',
    'qwertyuiop',
    'asdfgh',
    'asdfghjkl',
    'zxcvbnm',
    'qazwsx',
    '1qaz2wsx',
    'zaq12wsx',
    '1q2w3e4r',
    'q1w2e3r4',
    'abc',
    'abcd',
    'abcdef',
    'abcdefg',
    'abcdefgh',
    'admin',
    'administrator',
    'root',
    'letmein',
    'welcome',
    'monkey',
    'dragon',
    'master',
    'sunshine',
    'princess',
    'football',
    'baseball',
    'superman',
    'batman',
    'shadow',
    'michael',
    'qq',
    'wang',
    'zhang',
    'li',
    'liu',
    'chen',
    'hrt',
    'estradiol',
    'estrogen',
    'trans',
    'hello',
    'test',
    'guest',
    'secret',
    'changeme',
    'mima',
    'woshishui',
]);

const ROWS = [
    'qwertyuiop',
    'asdfghjkl',
    'zxcvbnm',
    '1234567890',
    '!@#$%^&*()',
    'abcdefghijklmnopqrstuvwxyz',
    '1qaz',
    '2wsx',
    '3edc',
    '4rfv',
    '5tgb',
    '6yhn',
    '7ujm',
    '8ik,',
    '9ol.',
    '0p;/',
];

const WORDS = [...COMMON].filter(word => word.length >= 4).sort((a, b) => b.length - a.length);

const LEET: Record<string, string> = {
    '0': 'o',
    '@': 'a',
    '4': 'a',
    $: 's',
    '5': 's',
    '3': 'e',
    '!': 'i',
    '7': 't',
    '+': 't',
};

const DATES = [
    /^(19|20)\d{2}[-./]?(0[1-9]|1[0-2])[-./]?(0[1-9]|[12]\d|3[01])/,
    /^(0[1-9]|[12]\d|3[01])[-./]?(0[1-9]|1[0-2])[-./]?(19|20)\d{2}/,
    /^(0[1-9]|1[0-2])[-./]?(0[1-9]|[12]\d|3[01])[-./]?(19|20)\d{2}/,
];

const dateLength = (text: string): number => {
    for (const pattern of DATES) {
        const match = pattern.exec(text);
        if (match) return match[0].length;
    }
    return 0;
};

export function analyzePasswordCharset(password: string): PasswordCharset {
    return {
        lower: LOWER.test(password),
        upper: UPPER.test(password),
        digits: DIGITS.test(password),
        symbols: SYMBOLS.test(password),
        nonAscii: NON_ASCII.test(password),
    };
}

export function charsetSize(charset: PasswordCharset): number {
    let size = 0;
    if (charset.lower) size += 26;
    if (charset.upper) size += 26;
    if (charset.digits) size += 10;
    if (charset.symbols) size += 33;
    if (charset.nonAscii) size += 100;
    return size;
}

const poolSize = (password: string): number => {
    const charset = analyzePasswordCharset(password);
    const onlySpaces = charset.symbols && !/[!-/:-@[-`{-~]/.test(password);
    return Math.max(charsetSize({ ...charset, symbols: false }) + (onlySpaces ? 1 : charset.symbols ? 33 : 0), 10);
};

const isStep = (a: string, b: string): boolean => {
    const lowerA = a.toLowerCase();
    const lowerB = b.toLowerCase();
    if (Math.abs(lowerA.charCodeAt(0) - lowerB.charCodeAt(0)) === 1) return true;
    return ROWS.some(row => {
        const i = row.indexOf(lowerA);
        return i >= 0 && (row[i + 1] === lowerB || row[i - 1] === lowerB);
    });
};

const patternAt = (chars: string[], swapped: string[][], i: number): { length: number; weight: number } | null => {
    const date = dateLength(chars.slice(i).join(''));
    if (date) return { length: date, weight: 2 };
    for (const word of WORDS) {
        if (swapped.some(variant => Array.from(word).every((letter, j) => variant[i + j] === letter))) {
            return { length: word.length, weight: 1 };
        }
    }
    const before = chars.slice(0, i).join('');
    for (let size = Math.min(chars.length - i, i); size >= 3; size--) {
        if (before.includes(chars.slice(i, i + size).join(''))) return { length: size, weight: 1 };
    }
    return null;
};

const effectiveLength = (lower: string): number => {
    const chars = Array.from(lower);
    const swapped = ['i', 'l'].map(one => chars.map(char => (char === '1' ? one : (LEET[char] ?? char))));
    let length = 0;
    let prev: string | null = null;
    let runLength = 0;
    for (let i = 0; i < chars.length;) {
        const pattern = patternAt(chars, swapped, i);
        if (pattern) {
            length += pattern.weight;
            prev = null;
            i += pattern.length;
            continue;
        }
        const cur = chars[i];
        if (prev !== null && (cur === prev || isStep(prev, cur))) {
            runLength++;
            if (runLength === 2) length += 0.5;
        } else {
            runLength = 1;
            length += 1;
        }
        prev = cur;
        i++;
    }
    return length;
};

/**
 * Estimates entropy in bits. Returns a conservative estimate (pessimistic about patterns).
 */
export function estimatePasswordBits(password: string): number {
    if (typeof password !== 'string' || !password) return 0;
    const lower = password.toLowerCase();
    const core = lower.replace(/[\d!-/:-@[-`{-~ ]+$/, '').replace(/^[\d!-/:-@[-`{-~ ]+/, '');
    if (COMMON.has(lower) || (core && COMMON.has(core) && lower.length - core.length <= 6)) return 10;
    if (dateLength(lower) === lower.length || /^(?:520|1314)+\d{0,4}$/.test(lower)) return 10;
    return Math.round(effectiveLength(lower) * Math.log2(poolSize(password)) * 10) / 10;
}

export function passwordStrength(password: string): PasswordStrength {
    const bits = estimatePasswordBits(password);
    if (bits < WEAK_BITS) return 'weak';
    if (bits < STRONG_BITS) return 'fair';
    return 'strong';
}

export function isPasswordAcceptable(password: string): { acceptable: boolean; reason?: string } {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return { acceptable: false, reason: 'too_short' };
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        return { acceptable: false, reason: 'too_long' };
    }
    const bits = estimatePasswordBits(password);
    if (bits < WEAK_BITS) {
        return { acceptable: false, reason: 'too_weak' };
    }
    return { acceptable: true };
}
