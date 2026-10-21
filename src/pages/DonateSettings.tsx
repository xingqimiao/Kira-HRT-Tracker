import React, { useRef, useState } from 'react';
import Icon from '../components/Icon';
import { Check, ChevronRight, Copy, Gift, Heart } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { AdaptiveSheet, HeaderBack, SegmentedListItem } from '../ui/proto';
import { applyForSupporter, type ApplyErrorCode } from '../services/supporters';
import { useSupporters } from '../hooks/useSupporters';
import TurnstileWidget, { TURNSTILE_CONFIGURED } from '../components/TurnstileWidget';
import { isSupporterTxHash, validateSupporterName, type SupporterNameProblem } from '../utils/supporterValidation';
import bmcButton from '../assets/brands/buymeacoffee.svg?url';
import afdianButton from '../assets/brands/afdian.png?url';
import btcMark from '../assets/brands/crypto/btc.svg?url';
import ethMark from '../assets/brands/crypto/eth.svg?url';
import bnbMark from '../assets/brands/crypto/bnb.svg?url';
import baseMark from '../assets/brands/crypto/base.svg?url';
import trxMark from '../assets/brands/crypto/trx.svg?url';
import solMark from '../assets/brands/crypto/sol.svg?url';
import arcMark from '../assets/brands/crypto/arc.svg?url';

const BMC_URL = 'https://www.buymeacoffee.com/kiramyao';

interface CryptoOption {
    name: string;
    address: string;
    mark: string;
}

/**
 * The tip jar, kept entirely local.
 *
 * The Buy Me a Coffee button is the provider's own generated SVG, fetched once and
 * committed under `assets/brands/` rather than hot-linked: the app is served with
 * `img-src 'self'`, so an `<img>` pointing at `img.buymeacoffee.com` would render as
 * an empty box in production. Same reason the chain marks are local files.
 */
const CRYPTO: CryptoOption[] = [
    { name: 'Bitcoin', address: 'bc1qrnxdt89lhfatu52k66d9ycdx87uskeuqdhcwj3', mark: btcMark },
    { name: 'Ethereum', address: '0xc992E943727076d38D78d99ff43d7b20dd73F481', mark: ethMark },
    { name: 'BNB Smart Chain', address: '0xc992E943727076d38D78d99ff43d7b20dd73F481', mark: bnbMark },
    { name: 'Base', address: '0xc992E943727076d38D78d99ff43d7b20dd73F481', mark: baseMark },
    { name: 'Tron', address: 'THjULZ4VpUfcXGSQnJExyjYuucUerrq2AZ', mark: trxMark },
    { name: 'Solana', address: '3b5fx2TrGVeNPm6GGZE4GPmjpiXRK4p32cZjriSTfDQy', mark: solMark },
    { name: 'Arc', address: '0xc992E943727076d38D78d99ff43d7b20dd73F481', mark: arcMark },
];

const CryptoRow: React.FC<CryptoOption> = ({ name, address, mark }) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const copy = () => {
        navigator.clipboard.writeText(address).then(() => {
            if (timerRef.current) clearTimeout(timerRef.current);
            setCopied(true);
            timerRef.current = setTimeout(() => setCopied(false), 2000);
        }).catch(() => undefined);
    };

    return (
        <button
            type="button"
            className="li"
            onClick={copy}
            style={{ textAlign: 'left' }}
            aria-label={copied ? `${t('donate.copied')} ${name}` : `${t('donate.copy')} ${name}`}
        >
            <span className="ic" style={{ background: 'transparent', padding: 0, overflow: 'hidden' }}>
                <img src={mark} alt="" width={32} height={32} style={{ display: 'block', width: 32, height: 32 }} />
            </span>
            <span className="t">
                <b>{name}</b>
                {/* One line, shrunk to fit: a wrapped address is harder to compare
                    at a glance, and the row itself is the copy target. The clamp
                    keeps 390px phones on one line; an unusually narrow one ellipsises
                    rather than pushing the layout around. */}
                <span
                    className="s"
                    style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        fontSize: 'clamp(8.5px, 2.6vw, 11.5px)',
                        letterSpacing: '-0.1px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {address}
                </span>
            </span>
            <span
                className="r"
                aria-hidden
                style={{ display: 'flex', alignItems: 'center', color: copied ? 'var(--ok)' : 'var(--out)' }}
            >
                <Icon icon={copied ? Check : Copy} size={18} strokeWidth={1.7} />
            </span>
        </button>
    );
};

/** The three form-level messages a nickname can produce. */
function nameProblemKey(problem: SupporterNameProblem): string {
    if (problem === 'too_long') return 'donate.error.name_too_long';
    if (problem === 'link' || problem === 'slash') return 'donate.error.name_link';
    return 'donate.error.name';
}

function serverErrorKey(code: ApplyErrorCode): string {
    switch (code) {
        case 'INVALID_TX_HASH': return 'donate.error.tx';
        case 'DUPLICATE_TX': return 'donate.error.duplicate';
        case 'RATE_LIMITED': return 'donate.error.rate';
        case 'TURNSTILE': return 'donate.error.turnstile';
        case 'NOT_FOUND': return 'donate.error.not_found';
        case 'UNCONFIRMED': return 'donate.error.unconfirmed';
        case 'NOT_RECEIVED': return 'donate.error.not_received';
        case 'VERIFY_UNAVAILABLE': return 'donate.error.verify_unavailable';
        case 'INVALID_NAME': return 'donate.error.name';
        default: return 'donate.error.network';
    }
}

/**
 * What the verifier accepts, per network.
 *
 * Kept next to the form (not only in the docs) because a donor with, say, USDC on
 * Base needs to know that it will be recognised, and someone holding a different
 * token needs to know it will not. The verifier's allowlists are the source of
 * truth; this list must change with them.
 */
const VERIFIED_ASSETS: [string, string][] = [
    ['Bitcoin', 'BTC'],
    ['Ethereum', 'ETH · USDT · USDC'],
    ['BNB Smart Chain', 'BNB · USDT · USDC'],
    ['Base', 'ETH · USDC'],
    ['Tron', 'TRX · USDT'],
    ['Solana', 'SOL · USDT · USDC'],
    ['Arc', 'USDC'],
];

const DonateSettings: React.FC<{ onBack: () => void; onOpenSupporters: () => void }> = ({ onBack, onOpenSupporters }) => {
    const { t } = useTranslation();
    const chevron = <Icon icon={ChevronRight} size={18} />;

    const { supporters, loaded: supportersLoaded } = useSupporters();
    const [applyOpen, setApplyOpen] = useState(false);

    const [txHash, setTxHash] = useState('');
    const [nickname, setNickname] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [applied, setApplied] = useState(false);
    const [turnstileToken, setTurnstileToken] = useState('');
    const [turnstileReset, setTurnstileReset] = useState(0);
    const humanVerified = !TURNSTILE_CONFIGURED || turnstileToken !== '';

    const resetApply = () => {
        setTxHash('');
        setNickname('');
        setError(null);
        setSubmitting(false);
        setApplied(false);
        setTurnstileToken('');
        setTurnstileReset(value => value + 1);
    };

    const closeApply = () => {
        setApplyOpen(false);
        resetApply();
    };

    const submitApply = async (event: React.FormEvent) => {
        event.preventDefault();
        if (submitting || !humanVerified) return;

        const nameCheck = validateSupporterName(nickname);
        if (nameCheck.problem) {
            setError(t(nameProblemKey(nameCheck.problem)));
            return;
        }
        if (!isSupporterTxHash(txHash)) {
            setError(t('donate.error.tx'));
            return;
        }

        setSubmitting(true);
        setError(null);
        const result = await applyForSupporter(txHash.trim(), nameCheck.name, turnstileToken);
        setSubmitting(false);
        if (result.ok) {
            setApplied(true);
            return;
        }
        // A Turnstile token is single-use; without a reset every retry would fail
        // with the same rejected token.
        setTurnstileToken('');
        setTurnstileReset(value => value + 1);
        setError(t(serverErrorKey(result.code)));
    };

    return (
        <div className="pg on long donate-page">
            <div className="lic-head">
                <HeaderBack title={t('donate.title')} onBack={onBack} backLabel={t('core.back')} />
            </div>

            <div className="d-col" style={{ gap: 12 }}>
                <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '22px 18px' }}>
                    <p className="sub" style={{ margin: 0, textAlign: 'center', lineHeight: 1.65 }}>
                        {t('donate.intro')}
                    </p>
                    <a
                        href={BMC_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Buy me a Kamaboko"
                        style={{ display: 'block', width: '100%', maxWidth: 280 }}
                    >
                        <img
                            src={bmcButton}
                            alt="Buy me a Kamaboko"
                            style={{ display: 'block', width: '100%', height: 'auto' }}
                        />
                    </a>
                    {/* Afdian's own button artwork, bundled for the same CSP reason as
                        the BMC one. The source PNG has transparent corners; using it
                        as-is avoids the white matte a `background:#fff` wrapper would
                        paint behind the rounded shape. */}
                    <a
                        href="https://afdian.com/a/kiramyao"
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('donate.afdian')}
                        style={{ display: 'block', width: '100%', maxWidth: 280 }}
                    >
                        <img
                            src={afdianButton}
                            alt={t('donate.afdian')}
                            style={{ display: 'block', width: '100%', height: 'auto' }}
                        />
                    </a>
                </div>

                <div className="lab">{t('donate.crypto_title')}</div>
                <div className="list">
                    {CRYPTO.map(option => (
                        <CryptoRow key={option.name} {...option} />
                    ))}
                    <SegmentedListItem
                        icon={Gift}
                        title={t('donate.apply_title')}
                        subtitle={t('donate.apply_desc')}
                        trailing={chevron}
                        onClick={() => setApplyOpen(true)}
                    />
                </div>

                <p className="sub" style={{ margin: '2px 6px 0', textAlign: 'center' }}>
                    {t('donate.crypto_hint')}
                </p>

                <div className="lab">{t('donate.supporters_title')}</div>
                {supporters.length > 0 ? (
                    <div className="list">
                        <SegmentedListItem
                            icon={Heart}
                            leadingTone="primary"
                            title={supporters[0].name}
                            subtitle={`${t('donate.latest_supporter')} · ${t('donate.view_all').replace('{n}', String(supporters.length))}`}                            trailing={chevron}
                            onClick={onOpenSupporters}
                        />
                    </div>
                ) : (
                    <div className="card">
                        <p className="sub" style={{ margin: 0, textAlign: 'center' }}>
                            {supportersLoaded ? t('donate.supporters_empty') : t('donate.supporters_loading')}
                        </p>
                    </div>
                )}
            </div>


            <AdaptiveSheet
                open={applyOpen}
                onClose={closeApply}
                title={t('donate.apply_title')}
                closeLabel={t('btn.close')}
            >
                {applied ? (
                    <div className="d-col" style={{ gap: 14 }}>
                        <p className="sub" style={{ margin: 0, lineHeight: 1.65 }}>{t('donate.apply_done')}</p>
                        <button type="button" className="btn" style={{ width: '100%', height: 50 }} onClick={closeApply}>
                            {t('btn.close')}
                        </button>
                    </div>
                ) : (
                    <form className="d-col" style={{ gap: 14 }} onSubmit={submitApply}>
                        <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>{t('donate.apply_intro')}</p>
                        <div style={{ display: 'grid', gap: 3 }}>
                            <p className="sub" style={{ margin: 0, fontWeight: 700 }}>{t('donate.apply_supported')}</p>
                            <div style={{ display: 'grid', gap: 2, fontSize: 12, lineHeight: 1.5, color: 'var(--var)' }}>
                                {VERIFIED_ASSETS.map(([network, coins]) => (
                                    <div key={network} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                                        <span>{network}</span>
                                        <span style={{ textAlign: 'right' }}>{coins}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <label>
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--var)' }}>{t('donate.apply_tx')}</span>
                            <div className="fld">
                                <input
                                    value={txHash}
                                    onChange={event => setTxHash(event.target.value)}
                                    placeholder="0x… / …"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    maxLength={100}
                                    style={{
                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                                        fontSize: 14,
                                        fontWeight: 500,
                                    }}
                                />
                            </div>
                        </label>

                        <label>
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--var)' }}>{t('donate.apply_name')}</span>
                            <div className="fld">
                                <input
                                    value={nickname}
                                    onChange={event => setNickname(event.target.value)}
                                    maxLength={32}
                                    style={{ fontSize: 16, fontWeight: 600 }}
                                />
                            </div>
                        </label>

                        {error ? <p style={{ margin: 0, color: 'var(--err)', fontSize: 13 }}>{error}</p> : null}

                        <TurnstileWidget action="donate" onToken={setTurnstileToken} resetSignal={turnstileReset} />

                        <button
                            type="submit"
                            className="btn"
                            style={{ width: '100%', height: 50 }}
                            disabled={submitting || !humanVerified}
                        >
                            {submitting ? t('donate.apply_submitting') : t('donate.apply_submit')}
                        </button>
                    </form>
                )}
            </AdaptiveSheet>
        </div>
    );
};

export default DonateSettings;
