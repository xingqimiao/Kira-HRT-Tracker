/**
 * Read a Featherline backup file.
 *
 * Featherline is the one source whose export is not JSON: a 65-byte binary header
 * followed by AES-256-GCM ciphertext over `gzip(json)`, the whole header fed in as
 * additional authenticated data. Its format is documented in the project's own
 * `docs/backup-format.md`, and this module is written against that document plus
 * its `BackupCrypto.kt` / `BackupSnapshot.kt` sources.
 *
 * ── Why Argon2 is loaded lazily ──────────────────────────────────────────────
 *
 * The envelope's key derivation is Argon2id, which WebCrypto does not provide. The
 * only way to read the file is therefore a WASM/JS Argon2. That dependency is
 * pulled in with a dynamic `import()` at the moment a Featherline file is actually
 * opened, so a user who never imports one never downloads it — the same rule the
 * app already follows for the OCR engine and the PK engine (see `src/engine/registry.ts`).
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 *
 * It does not import `logic.ts`, and it emits plain string `route`/`ester` values
 * rather than those enums. The existing `sanitizeImported*` helpers in `useAppData`
 * validate and coerce every record anyway, so emitting plain data keeps this module
 * free of the app's runtime graph — which is what lets `scripts/check-foreign-import.mjs`
 * exercise it headlessly, with a real encrypt/decrypt round trip.
 */

/** A record shaped for `sanitizeImportedEvents`, before that helper sees it. */
interface RawDose {
    id: string;
    timeH: number;
    route: string;
    ester: string;
    doseMG: number;
    extras?: Record<string, number>;
}

/** A record shaped for `sanitizeImportedLabResults`. */
interface RawLab {
    id: string;
    timeH: number;
    concValue: number;
    unit: string;
    monitoringOnly?: boolean;
    prolactin?: number;
    prolactinUln?: number;
    alt?: number;
    altUln?: number;
    ast?: number;
    potassium?: number;
}

export interface FeatherlineImport {
    events: RawDose[];
    labResults: RawLab[];
    /** kg, when the profile carried one. */
    weight?: number;
    /** Rows dropped, and why — surfaced to the user rather than silently lost. */
    skipped: {
        doses: number;
        labs: number;
        /** One human-readable reason per distinct cause, not one per row. */
        reasons: string[];
    };
}

/** Thrown for a file this module recognises but cannot read. */
export class FeatherlineError extends Error {}

// ── The envelope ─────────────────────────────────────────────────────────────

const MAGIC = 'HRTBKP1';
const HEADER_FIXED_V2 = 28;
const HEADER_FIXED_V3 = 37;
const KDF_ARGON2_ID = 2;
const CIPHER_AES_256_GCM = 1;
const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;
const AES_KEY_LENGTH_BYTES = 32;
/** Bounds mirrored from BackupCrypto.kt, so a hostile header cannot OOM the tab. */
const MAX_TIME_COST = 10;
const MAX_MEMORY_KIB = 256 * 1024;
const MAX_PARALLELISM = 4;
/** A decompression-bomb ceiling, the same one the writer enforces. */
const MAX_JSON_BYTES = 128 * 1024 * 1024;

const utf8 = new TextDecoder();

/** True when these bytes begin with Featherline's magic. */
export function isFeatherlineBackup(bytes: Uint8Array): boolean {
    if (bytes.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i++) {
        if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
    }
    return true;
}

interface Container {
    /** The full header — also the AES-GCM additional authenticated data. */
    header: Uint8Array;
    salt: Uint8Array;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    compression: number;
    argon2: { iterations: number; memoryKib: number; parallelism: number; hashLength: number };
}

function readContainer(bytes: Uint8Array): Container {
    if (!isFeatherlineBackup(bytes)) throw new FeatherlineError('not a Featherline backup');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let at = MAGIC.length;
    const version = bytes[at++];
    const kdf = bytes[at++];
    const cipher = bytes[at++];

    if (kdf !== KDF_ARGON2_ID) throw new FeatherlineError(`unsupported KDF ${kdf}`);
    if (cipher !== CIPHER_AES_256_GCM) throw new FeatherlineError(`unsupported cipher ${cipher}`);

    // v2 predates the compression byte and the uncompressed-length field; its
    // payload is stored uncompressed. Featherline still reads it, so we do too.
    let compression = COMPRESSION_NONE;
    let uncompressedLength: number | null = null;
    if (version === 3) {
        compression = bytes[at++];
    } else if (version !== 2) {
        throw new FeatherlineError(`unsupported container version ${version}`);
    }

    if (version === 3) {
        // int64 big-endian. Read as two 32-bit halves: BigInt-free and safe here
        // because the writer caps the value far below 2^53.
        const hi = view.getUint32(at); at += 4;
        const lo = view.getUint32(at); at += 4;
        uncompressedLength = hi * 0x1_0000_0000 + lo;
        if (uncompressedLength > MAX_JSON_BYTES) throw new FeatherlineError('declared payload too large');
    }

    const iterations = view.getInt32(at); at += 4;
    const memoryKib = view.getInt32(at); at += 4;
    const parallelism = view.getInt32(at); at += 4;
    const hashLength = view.getInt32(at); at += 4;

    // Reject a hostile or corrupt KDF profile before spending memory on it —
    // Argon2 runs before the AES-GCM tag is checked, so an unbounded cost in an
    // unauthenticated header would otherwise hang the tab.
    if (iterations < 1 || iterations > MAX_TIME_COST) throw new FeatherlineError('unsupported Argon2 time cost');
    if (memoryKib < 1 || memoryKib > MAX_MEMORY_KIB) throw new FeatherlineError('unsupported Argon2 memory cost');
    if (parallelism < 1 || parallelism > MAX_PARALLELISM) throw new FeatherlineError('unsupported Argon2 parallelism');
    if (hashLength !== AES_KEY_LENGTH_BYTES) throw new FeatherlineError('unsupported Argon2 hash length');

    const saltLength = bytes[at++];
    const nonceLength = bytes[at++];
    if (saltLength < 1 || nonceLength < 1) throw new FeatherlineError('invalid salt or nonce length');

    const fixed = version === 3 ? HEADER_FIXED_V3 : HEADER_FIXED_V2;
    const headerLength = fixed + saltLength + nonceLength;
    if (bytes.length <= headerLength) throw new FeatherlineError('truncated container');

    const salt = bytes.subarray(at, at + saltLength); at += saltLength;
    const nonce = bytes.subarray(at, at + nonceLength); at += nonceLength;

    return {
        header: bytes.subarray(0, headerLength),
        salt,
        nonce,
        ciphertext: bytes.subarray(headerLength),
        compression,
        argon2: { iterations, memoryKib, parallelism, hashLength },
    };
}

/**
 * Decrypt a Featherline backup to its snapshot JSON.
 *
 * `hash-wasm` is imported here and nowhere else, so its weight is paid only when a
 * Featherline file is actually opened.
 */
export async function decryptFeatherline(bytes: Uint8Array, password: string): Promise<string> {
    const container = readContainer(bytes);

    const { argon2id } = await import('hash-wasm');
    // The parameters come out of the file, not our defaults: a backup written
    // with stronger settings must still open with those settings.
    const keyBytes = await argon2id({
        password,
        salt: container.salt,
        parallelism: container.argon2.parallelism,
        iterations: container.argon2.iterations,
        memorySize: container.argon2.memoryKib,
        hashLength: container.argon2.hashLength,
        outputType: 'binary',
    });

    const key = await crypto.subtle.importKey(
        'raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['decrypt'],
    );

    let compressed: ArrayBuffer;
    try {
        compressed = await crypto.subtle.decrypt(
            // The whole header is authenticated, so a tampered parameter fails here
            // rather than yielding a wrong key silently.
            { name: 'AES-GCM', iv: container.nonce as BufferSource, additionalData: container.header as BufferSource },
            key,
            container.ciphertext as BufferSource,
        );
    } catch {
        // Wrong password and tampered ciphertext are indistinguishable by design —
        // AES-GCM cannot tell them apart, and neither can we.
        throw new FeatherlineError('wrong password or damaged file');
    }

    if (container.compression === COMPRESSION_NONE) return utf8.decode(compressed);
    if (container.compression !== COMPRESSION_GZIP) throw new FeatherlineError('unsupported compression');

    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const json = await new Response(stream).text();
    if (json.length > MAX_JSON_BYTES) throw new FeatherlineError('payload too large');
    return json;
}

// ── Snapshot → this app's records ────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Featherline's 8-digit app identity, so we refuse another app's backup. */
const FEATHERLINE_PACKAGE = 'com.mkx.hrttracker';

/**
 * Featherline's `applicationType` (and the shapes a migration left behind) → our
 * `Route` value, or null when we have no equivalent.
 */
function routeFor(value: unknown): string | null {
    const token = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
    switch (token) {
        case 'injection': case 'inject': case 'injected': case 'importedinjection':
        case 'subcutaneous': case 'intramuscular':
            return 'injection';
        case 'oral': case 'pill': case 'importedpill': case 'tablet': case 'capsule':
            return 'oral';
        case 'sublingual': case 'sl':
            return 'sublingual';
        case 'gel': case 'importedgel': case 'topical':
            return 'gel';
        case 'patchon': case 'patchapply': case 'patch': case 'transdermal':
            return 'patchApply';
        case 'patchoff': case 'patchremove':
            return 'patchRemove';
        default:
            return null;
    }
}

/**
 * A substance name — from a catalog key (`ESTRADIOL_VALERATE`), a custom name, or
 * an imported identity key's compound segment — to one of our `Ester` values.
 *
 * One table covers all three because all three arrive as text. The longest names
 * are tested first so `ESTRADIOL` cannot win over `ESTRADIOL_VALERATE`.
 */
const ESTER_TABLE: ReadonlyArray<[string, string]> = [
    ['estradiolvalerate', 'EV'], ['estradiolbenzoate', 'EB'],
    ['estradiolcypionate', 'EC'], ['estradiolenanthate', 'EN'],
    ['estradiolundecylate', 'EU'], ['estradiolundecanoate', 'EU'],
    ['estradiol', 'E2'],
    ['cyproteroneacetate', 'CPA'], ['cyproterone', 'CPA'], ['cpa', 'CPA'],
    ['spironolactone', 'SPIRO'], ['spiro', 'SPIRO'],
    ['bicalutamide', 'BICAL'], ['bica', 'BICAL'],
    ['testosteronecypionate', 'TC'], ['testosteroneenanthate', 'TE'],
    ['testosteroneundecanoate', 'TU'], ['testosterone', 'T'],
    ['ev', 'EV'], ['eb', 'EB'], ['ec', 'EC'], ['en', 'EN'], ['eu', 'EU'],
];

function esterFor(...candidates: unknown[]): string | null {
    const hay = candidates
        .filter((c) => typeof c === 'string' && c !== '')
        .join('|')
        .toLowerCase()
        .replace(/[^a-z0-9|]/g, '');
    // Split on the identity-key separator too, so each segment is matched whole.
    const parts = hay.split('|').flatMap((p) => p.split('_'));
    for (const [needle, ester] of ESTER_TABLE) {
        if (parts.includes(needle)) return ester;
    }
    return null;
}

/**
 * Trim the float-reconstruction noise a Featherline dose arrives with.
 *
 * Their dose is *reconstructed* rather than stored — a strength divided by a ratio,
 * or a fraction times a strength — so a 12.5 mg tablet comes through as
 * 12.499934062706513. Passing that on puts a meaningless run of digits in the user's
 * timeline, and it is the kind of "wrong" that makes them doubt the whole import.
 *
 * Three significant figures is what recovers the number they typed. Checked against
 * a real export: 12.499934 -> 12.5, 8.25063 -> 8.25, 6.249967 -> 6.25, 10.000253 ->
 * 10, while a genuinely precise 0.935 survives untouched. (Featherline does the same
 * thing on its side, at six significant figures, for the same reason.)
 */
function roundDose(mg: number): number {
    return Number(mg.toPrecision(3));
}

/**
 * The dose in mg of the substance, from the log's instruction and the medicine's
 * per-shape strength.
 *
 * `equivalentE2Mg` is deliberately NOT used: it is the estradiol equivalent the PK
 * engine consumes, and our `doseMG` means the mass actually taken (a 2 mg valerate
 * tablet is `doseMG: 2`, not `1.53`). See docs/hrt-import-export-protocol.md §7.
 * For a gel the two happen to be equal — the applied estradiol *is* the PK input —
 * which is why a real gel export shows the same number in both fields, and why
 * reading `strengthMgPerVial` here is not the coincidence it looks like.
 */
function doseMgFor(log: Record<string, any>, medicine: Record<string, any> | undefined): number | null {
    const count = num(log.count) ?? 1;
    const n = num(log.tabletFractionNumerator);
    const d = num(log.tabletFractionDenominator);
    const fraction = n !== null && d !== null && d !== 0 ? n / d : 1;

    if (medicine) {
        const prep = String(medicine.preparationType ?? '').toLowerCase();
        // A pill or capsule dose is its per-unit strength times the fraction taken.
        if ((prep.includes('pill') || prep.includes('capsule')) && num(medicine.strengthMgPerTablet) !== null) {
            return roundDose((medicine.strengthMgPerTablet as number) * fraction * count);
        }
        if (prep.includes('patch') && num(medicine.patchTotalMg) !== null) {
            return roundDose((medicine.patchTotalMg as number) * count);
        }
        // An imported injection or gel stores the administered mg directly (the
        // format doc is explicit about this), so the vial/concentration fields are
        // the fallbacks rather than the primary reading.
        if (num(medicine.concentrationMgPerMl) !== null && num(log.doseVolumeMl) !== null) {
            return roundDose((medicine.concentrationMgPerMl as number) * (log.doseVolumeMl as number) * count);
        }
        if (num(medicine.strengthMgPerVial) !== null) {
            return roundDose((medicine.strengthMgPerVial as number) * count);
        }
    }
    // Last resort: an imported gel row may carry its own applied weight.
    const grams = num(log.doseWeightGrams);
    if (grams !== null) return roundDose(grams * count);
    return null;
}

/** Featherline unit tokens (`pg_ml`, `pmol_l`) → ours (`pg/ml`, `pmol/l`). */
function unitFor(value: unknown): string | null {
    const token = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
    switch (token) {
        case 'pgml': return 'pg/ml';
        case 'pmoll': return 'pmol/l';
        case 'ngdl': return 'ng/dl';
        case 'nmoll': return 'nmol/l';
        default: return null;
    }
}

/** Which of our lab fields a built-in analyte key fills, if any. */
function analyteFor(key: unknown): 'e2' | 't' | 'prolactin' | 'alt' | 'ast' | 'potassium' | null {
    const token = String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    switch (token) {
        case 'e2': case 'estradiol': return 'e2';
        case 't': case 'testosterone': return 't';
        case 'prl': case 'prolactin': return 'prolactin';
        case 'alt': return 'alt';
        case 'ast': return 'ast';
        case 'k': case 'potassium': return 'potassium';
        default: return null;
    }
}

/**
 * Map a decrypted Featherline snapshot onto this app's records.
 *
 * Returns plain data for the import pipeline to validate; see the module header for
 * why this does not build the app's enum-typed records directly.
 */
export function mapFeatherlineSnapshot(json: string): FeatherlineImport {
    let snap: Record<string, any>;
    try {
        snap = JSON.parse(json);
    } catch {
        throw new FeatherlineError('snapshot is not valid JSON');
    }
    if (!isObj(snap)) throw new FeatherlineError('snapshot is not an object');

    const app = isObj(snap.app) ? snap.app : null;
    if (app && typeof app.packageName === 'string' && app.packageName !== FEATHERLINE_PACKAGE) {
        // A different app's backup with the same envelope. Refusing is the only
        // honest answer: the snapshot tree is theirs, not ours.
        throw new FeatherlineError(`backup belongs to another app (${app.packageName})`);
    }

    const skipped = { doses: 0, labs: 0, reasons: [] as string[] };
    const reason = (r: string) => { if (!skipped.reasons.includes(r)) skipped.reasons.push(r); };

    // The medicine identity each log points at, for strength and compound lookup.
    const medicines = new Map<string, Record<string, any>>();
    for (const m of arr(snap.medicines)) {
        if (isObj(m) && typeof m.uuid === 'string') medicines.set(m.uuid, m);
    }

    const events: RawDose[] = [];
    for (const log of arr(snap.medicationLogs)) {
        if (!isObj(log)) { skipped.doses++; reason('malformed dose row'); continue; }
        const appliedAt = num(log.appliedAtEpochMillis);
        if (appliedAt === null) { skipped.doses++; reason('dose row without a time'); continue; }

        const medicine = typeof log.medicineUuid === 'string' ? medicines.get(log.medicineUuid) : undefined;
        const route = routeFor(log.applicationType);
        if (route === null) { skipped.doses++; reason(`unsupported route "${log.applicationType}"`); continue; }

        // A patch removal carries no dose of its own; everything else must.
        if (route === 'patchRemove') {
            events.push({
                id: String(log.uuid ?? `fl-${appliedAt}`),
                timeH: appliedAt / 3_600_000,
                route,
                ester: 'E2',
                doseMG: 0,
            });
            continue;
        }

        const ester = esterFor(
            medicine?.medicationKey, medicine?.customMedicationName,
            medicine?.identityKey, log.category,
        );
        if (ester === null) { skipped.doses++; reason('dose with an unrecognised substance'); continue; }

        const doseMG = doseMgFor(log, medicine);
        if (doseMG === null || doseMG <= 0) { skipped.doses++; reason('dose whose amount could not be derived'); continue; }

        events.push({
            id: String(log.uuid ?? `fl-${appliedAt}`),
            timeH: appliedAt / 3_600_000,
            route,
            ester,
            doseMG,
        });
    }

    // One panel becomes one lab record: our model carries the hormone reading and
    // any monitoring values on the same row, which is what a single draw is.
    const labResults: RawLab[] = [];
    for (const panel of arr(snap.bloodTestPanels)) {
        if (!isObj(panel)) { skipped.labs++; reason('malformed lab panel'); continue; }
        const collectedAt = num(panel.collectedAtInstantEpochMillis);
        if (collectedAt === null) { skipped.labs++; reason('lab panel without a time'); continue; }

        let hormone: { value: number; unit: string; kind: 'e2' | 't' } | null = null;
        const monitoring: Partial<Record<'prolactin' | 'alt' | 'ast' | 'potassium', number>> = {};

        for (const result of arr(panel.results)) {
            if (!isObj(result)) continue;
            const kind = analyteFor(result.builtinAnalyteKey);
            const value = num(result.value);
            if (kind === null || value === null) continue;

            if (kind === 'e2' || kind === 't') {
                // Prefer the first hormone reading; a panel with two would need two
                // rows, which our one-reading-per-record model cannot express.
                if (hormone === null) {
                    const unit = unitFor(result.unitSnapshot);
                    if (unit === null) { continue; }
                    hormone = { value, unit, kind };
                }
            } else {
                monitoring[kind] = value;
            }
        }

        if (hormone === null && Object.keys(monitoring).length === 0) {
            skipped.labs++;
            reason('lab panel with no reading we carry');
            continue;
        }

        labResults.push({
            id: String(panel.uuid ?? `fl-lab-${collectedAt}`),
            timeH: collectedAt / 3_600_000,
            // Our model requires a value and a unit even on a monitoring-only row;
            // the placeholder is neutral and `monitoringOnly` keeps it unplotted.
            concValue: hormone?.value ?? 0,
            unit: hormone?.unit ?? 'pg/ml',
            ...(hormone === null ? { monitoringOnly: true } : {}),
            ...monitoring,
        });
    }

    const profile = isObj(snap.userProfile) ? snap.userProfile : null;
    const weight = profile ? num(profile.weightKg) : null;

    return {
        events,
        labResults,
        ...(weight !== null && weight > 0 ? { weight } : {}),
        skipped,
    };
}
