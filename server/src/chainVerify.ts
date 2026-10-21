/**
 * Confirm that a submitted transaction actually paid one of the donation addresses.
 *
 * No explorer API keys: each chain is asked through a public endpoint that accepts
 * anonymous reads. That is also why every call goes through a shared budget — public
 * RPCs rate-limit by IP, and one abusive client must not be able to burn the budget
 * for everyone else.
 *
 * The amount is deliberately not published or thresholded: the thank-you list is
 * about whether support arrived, not how much. What is checked is that value moved
 * to one of the addresses below.
 */

export type DonationChain = 'ethereum' | 'bnb' | 'base' | 'arc' | 'tron' | 'solana' | 'bitcoin';

export type VerificationStatus = 'verified' | 'unconfirmed' | 'not_received' | 'not_found' | 'unavailable';

export interface VerificationResult {
  status: VerificationStatus;
  chain?: DonationChain;
}

const EVM_ADDRESS = '0xc992e943727076d38d78d99ff43d7b20dd73f481';
const BTC_ADDRESS = 'bc1qrnxdt89lhfatu52k66d9ycdx87uskeuqdhcwj3';
const TRON_ADDRESS = 'THjULZ4VpUfcXGSQnJExyjYuucUerrq2AZ';
const SOL_ADDRESS = '3b5fx2TrGVeNPm6GGZE4GPmjpiXRK4p32cZjriSTfDQy';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Known stablecoin contracts, per chain.
 *
 * A random ERC-20 can be minted to any address for free, so "some token moved to
 * you" is not proof of payment. Only the stablecoins people actually donate are
 * accepted as token payments.
 */
const EVM_CHAINS: { id: DonationChain; rpc: string; tokens: Set<string> }[] = [
    {
        id: 'ethereum',
        rpc: 'https://cloudflare-eth.com',
        tokens: new Set([
            '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
        ]),
    },
    {
        id: 'bnb',
        rpc: 'https://bsc-dataseed.bnbchain.org',
        tokens: new Set([
            '0x55d398326f99059ff775485246999027b3197955', // USDT
            '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
        ]),
    },
    {
        id: 'base',
        rpc: 'https://mainnet.base.org',
        tokens: new Set([
            '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
        ]),
    },
    {
        // Arc's native currency is USDC, so a plain value transfer is the payment.
        id: 'arc',
        rpc: 'https://rpc.mainnet.arc.io',
        tokens: new Set(),
    },
];

const TRON_API = 'https://api.trongrid.io';
const SOL_RPC = 'https://api.mainnet-beta.solana.com';
const MEMPOOL_API = 'https://mempool.space/api';
const TRON_USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

/**
 * The SPL tokens accepted as a payment.
 *
 * Same reasoning as the ERC-20 allowlist: any SPL token can be minted to a wallet,
 * so "my token balance went up" is not proof of payment on its own. USDC and USDT
 * are what people actually send.
 */
const SOLANA_TOKENS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const CALL_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;
/** Outbound chain calls per rolling minute, across all applications. */
const CALLS_PER_MINUTE = 30;

const callTimes: number[] = [];
const cache = new Map<string, { at: number; result: VerificationResult }>();

class BudgetExhausted extends Error {
    constructor() {
        super('chain verification budget exhausted');
    }
}

/** Reserve one outbound call, or throw when the minute's budget is spent. */
function takeCall(): void {
    const now = Date.now();
    while (callTimes.length > 0 && callTimes[0] < now - 60_000) callTimes.shift();
    if (callTimes.length >= CALLS_PER_MINUTE) throw new BudgetExhausted();
    callTimes.push(now);
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
    takeCall();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchStatus(url: string): Promise<{ status: number; body: unknown }> {
    takeCall();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        const body = response.ok ? await response.json().catch(() => null) : null;
        return { status: response.status, body };
    } finally {
        clearTimeout(timer);
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

function evmNativePaid(tx: Record<string, unknown>): boolean {
    const to = String(tx.to ?? '').toLowerCase();
    if (to !== EVM_ADDRESS) return false;
    try {
        return BigInt(String(tx.value ?? '0x0')) > 0n;
    } catch {
        return false;
    }
}

function evmTokenPaid(receipt: Record<string, unknown>, tokens: Set<string>): boolean {
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    for (const raw of logs) {
        const log = asRecord(raw);
        if (!log) continue;
        const topics = Array.isArray(log.topics) ? log.topics : [];
        if (topics.length < 3) continue;
        if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
        if (!tokens.has(String(log.address ?? '').toLowerCase())) continue;
        const to = `0x${String(topics[2]).slice(-40).toLowerCase()}`;
        try {
            if (to === EVM_ADDRESS && BigInt(String(log.data ?? '0x0')) > 0n) return true;
        } catch {
            // Malformed log data is not a payment.
        }
    }
    return false;
}

async function verifyEvmChain(
    chain: (typeof EVM_CHAINS)[number],
    hash: string,
): Promise<VerificationStatus> {
    const txResponse = asRecord(await fetchJson(chain.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] }),
    }));
    const tx = asRecord(txResponse?.result);
    if (!tx) return 'not_found';

    const receiptResponse = asRecord(await fetchJson(chain.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [hash] }),
    }));
    const receipt = asRecord(receiptResponse?.result);
    if (!receipt || !tx.blockNumber) return 'unconfirmed';
    if (String(receipt.status) !== '0x1') return 'not_received';
    return evmNativePaid(tx) || evmTokenPaid(receipt, chain.tokens) ? 'verified' : 'not_received';
}

// ---------------------------------------------------------------------------
// Tron
// ---------------------------------------------------------------------------

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a base58 address; Tron's are 0x41 + 20 bytes + a 4-byte checksum. */
function base58Decode(input: string): Buffer {
    let value = 0n;
    for (const char of input) {
        const index = BASE58.indexOf(char);
        if (index < 0) throw new Error('invalid base58');
        value = value * 58n + BigInt(index);
    }
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const bytes = Buffer.from(hex, 'hex');
    let leadingZeros = 0;
    while (leadingZeros < input.length && input[leadingZeros] === '1') leadingZeros += 1;
    return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
}

function tronAddressHex(address: string): string {
    try {
        const bytes = base58Decode(address);
        if (bytes.length !== 25 || bytes[0] !== 0x41) return '';
        return bytes.subarray(0, 21).toString('hex');
    } catch {
        return '';
    }
}

const TRON_OURS = tronAddressHex(TRON_ADDRESS);

async function verifyTron(hash: string): Promise<VerificationStatus> {
    const txResponse = asRecord(await fetchJson(`${TRON_API}/wallet/gettransactionbyid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: hash }),
    }));
    if (!txResponse || !txResponse.txID) return 'not_found';

    const info = asRecord(await fetchJson(`${TRON_API}/wallet/gettransactioninfobyid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: hash }),
    }));
    if (!info || !info.blockNumber) return 'unconfirmed';
    const receipt = asRecord(info.receipt);
    if (receipt && receipt.result && receipt.result !== 'SUCCESS') return 'not_received';

    const raw = asRecord(txResponse.raw_data);
    const contracts = Array.isArray(raw?.contract) ? raw.contract : [];
    for (const rawContract of contracts) {
        const contract = asRecord(rawContract);
        const parameter = asRecord(contract?.parameter);
        const value = asRecord(parameter?.value);
        if (!value) continue;

        if (contract?.type === 'TransferContract') {
            const to = String(value.to_address ?? '').toLowerCase();
            const amount = Number(value.amount ?? 0);
            if (to === TRON_OURS && amount > 0) return 'verified';
        }

        if (contract?.type === 'TriggerSmartContract') {
            if (String(value.contract_address ?? '').toLowerCase() !== TRON_USDT_HEX) continue;
            const data = String(value.data ?? '').toLowerCase();
            // transfer(address,uint256): 4-byte selector + 32-byte to + 32-byte amount.
            if (!data.startsWith('a9059cbb') || data.length < 8 + 64 + 64) continue;
            const to = `41${data.slice(8 + 24, 8 + 64)}`;
            const amount = BigInt(`0x${data.slice(8 + 64, 8 + 128)}`);
            if (to === TRON_OURS && amount > 0n) return 'verified';
        }
    }
    return 'not_received';
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

async function verifySolana(hash: string): Promise<VerificationStatus> {
    const response = asRecord(await fetchJson(SOL_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [hash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
        }),
    }));
    const result = asRecord(response?.result);
    if (!result) return 'not_found';

    const meta = asRecord(result.meta);
    if (!meta) return 'unconfirmed';
    if (meta.err) return 'not_received';

    const transaction = asRecord(result.transaction);
    const message = asRecord(transaction?.message);
    const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
    const index = keys.findIndex(raw => {
        if (typeof raw === 'string') return raw === SOL_ADDRESS;
        const key = asRecord(raw);
        return key?.pubkey === SOL_ADDRESS;
    });
    const pre = Array.isArray(meta.preBalances) ? meta.preBalances : [];
    const post = Array.isArray(meta.postBalances) ? meta.postBalances : [];
    if (index >= 0) {
        const before = Number(pre[index] ?? 0);
        const after = Number(post[index] ?? 0);
        if (after - before > 0) return 'verified';
    }

    // SPL tokens: the owner's post balance for a mint exceeds its pre balance.
    const preTokens = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
    const postTokens = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
    for (const raw of postTokens) {
        const entry = asRecord(raw);
        if (!entry || entry.owner !== SOL_ADDRESS) continue;
        if (!SOLANA_TOKENS.has(String(entry.mint ?? ''))) continue;
        const accountIndex = entry.accountIndex;
        const mint = entry.mint;
        const beforeEntry = preTokens
            .map(asRecord)
            .find(candidate => candidate && candidate.accountIndex === accountIndex && candidate.mint === mint);
        const beforeAmount = asRecord(beforeEntry?.uiTokenAmount);
        const afterAmount = asRecord(entry.uiTokenAmount);
        try {
            if (BigInt(String(afterAmount?.amount ?? '0')) > BigInt(String(beforeAmount?.amount ?? '0'))) {
                return 'verified';
            }
        } catch {
            // Ignore malformed amounts.
        }
    }
    return 'not_received';
}

// ---------------------------------------------------------------------------
// Bitcoin
// ---------------------------------------------------------------------------

async function verifyBitcoin(hash: string): Promise<VerificationStatus> {
    const { status, body } = await fetchStatus(`${MEMPOOL_API}/tx/${hash}`);
    if (status === 404) return 'not_found';
    if (status !== 200) return 'unavailable';
    const tx = asRecord(body);
    if (!tx) return 'unavailable';
    const txStatus = asRecord(tx.status);
    if (txStatus?.confirmed !== true) return 'unconfirmed';
    const outputs = Array.isArray(tx.vout) ? tx.vout : [];
    const paid = outputs.some(raw => {
        const out = asRecord(raw);
        return out?.scriptpubkey_address === BTC_ADDRESS && Number(out.value ?? 0) > 0;
    });
    return paid ? 'verified' : 'not_received';
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-chain outcomes into one answer the form can act on.
 *
 * `unavailable` outranks `not_found`: if one provider timed out, "not found" is not
 * something we can honestly claim. A definitive `not_received` from a chain that did
 * answer is more useful than either.
 */
function combine(outcomes: VerificationStatus[], chains: DonationChain[]): VerificationResult {
    const verifiedIndex = outcomes.indexOf('verified');
    if (verifiedIndex >= 0) return { status: 'verified', chain: chains[verifiedIndex] };
    if (outcomes.includes('not_received')) return { status: 'not_received' };
    if (outcomes.includes('unconfirmed')) return { status: 'unconfirmed' };
    if (outcomes.includes('unavailable')) return { status: 'unavailable' };
    return { status: 'not_found' };
}

async function runChain(chain: DonationChain, task: () => Promise<VerificationStatus>): Promise<VerificationStatus> {
    try {
        return await task();
    } catch {
        return 'unavailable';
    }
}

/**
 * Verify one transaction. Results are cached for a minute: a user retrying after
 * "unconfirmed" should not spend the shared RPC budget on every click.
 */
export async function verifyDonation(txHash: string): Promise<VerificationResult> {
    if (verifierOverride) return verifierOverride(txHash);

    const cached = cache.get(txHash);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

    let result: VerificationResult;
    try {
        if (/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
            const outcomes = await Promise.all(
                EVM_CHAINS.map(chain => runChain(chain.id, () => verifyEvmChain(chain, txHash))),
            );
            result = combine(outcomes, EVM_CHAINS.map(chain => chain.id));
        } else if (/^[0-9a-fA-F]{64}$/.test(txHash)) {
            const [bitcoin, tron] = await Promise.all([
                runChain('bitcoin', () => verifyBitcoin(txHash)),
                runChain('tron', () => verifyTron(txHash)),
            ]);
            result = combine([bitcoin, tron], ['bitcoin', 'tron']);
        } else {
            result = combine([await runChain('solana', () => verifySolana(txHash))], ['solana']);
        }
    } catch {
        result = { status: 'unavailable' };
    }

    if (cache.size > 500) cache.clear();
    cache.set(txHash, { at: Date.now(), result });
    return result;
}

/** Test seam: clear the cache and the per-minute budget. */
export function __resetChainVerifierForTest(): void {
    cache.clear();
    callTimes.length = 0;
}

type VerifierOverride = (txHash: string) => Promise<VerificationResult>;
let verifierOverride: VerifierOverride | null = null;

/**
 * Test seam: replace the network verifier.
 *
 * The suite cannot ask public RPCs for a transaction it invented, and it must not
 * depend on the internet at all. The real endpoint providers are covered by the
 * shapes they return, not by live calls.
 */
export function __setDonationVerifierForTest(replacement: VerifierOverride | null): void {
    verifierOverride = replacement;
}
