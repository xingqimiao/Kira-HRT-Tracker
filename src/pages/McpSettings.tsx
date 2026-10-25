import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import { AlertTriangle, Check, Copy, Edit2, KeyRound, Plus, Trash2, X } from '../icons';
import { Progress } from '../components/ui';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { coreAuth, type ApiToken } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { MCP_ENDPOINT } from '../constants';
import CopyRow from '../components/CopyRow';
import { buildMcpInstallPrompt } from '../utils/mcpInstallPrompt';
import { useEscape } from '../hooks/useEscape';
import { HeaderBack } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';

interface McpSettingsProps {
    session: CoreSession;
    onBack: () => void;
    /** Start the Core sign-in, when there is no session to mint a token with. */
    onSignIn: () => void;
}

const MCP_TOOLS: { name: string }[] = [
    { name: 'hrt_get_timeline' },
    { name: 'hrt_list_medications' },
    { name: 'hrt_list_labs' },
    { name: 'hrt_list_journal' },
    { name: 'hrt_list_dose_templates' },
    { name: 'hrt_predict_levels' },
    { name: 'hrt_check_advisories' },
    { name: 'hrt_med_plan_status' },
    { name: 'hrt_get_settings' },
    { name: 'hrt_reference' },
    { name: 'hrt_add_medication' },
    { name: 'hrt_add_lab_result' },
    { name: 'hrt_add_journal_entry' },
    { name: 'hrt_add_dose_template' },
    { name: 'hrt_update_settings' },
    { name: 'hrt_delete_record' },
    { name: 'hrt_create_share' },
    { name: 'hrt_list_shares' },
    { name: 'hrt_revoke_share' },
];

const StepHeading: React.FC<{ n: number; title: string; desc?: string }> = ({ n, title, desc }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            background: 'var(--pric)',
            color: 'var(--onpric)',
            fontSize: 13,
            fontWeight: 800,
            display: 'grid',
            placeItems: 'center',
            flex: 'none',
        }}>
            {n}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
            <b style={{ fontSize: 15, display: 'block', color: 'var(--on)' }}>{title}</b>
            {desc && <span className="sub" style={{ margin: 0, display: 'block', marginTop: 2, fontSize: 12 }}>{desc}</span>}
        </div>
    </div>
);

const MintTokenModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onGenerate: (name: string) => void;
    busy: boolean;
}> = ({ isOpen, onClose, onGenerate, busy }) => {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    useEscape(onClose, isOpen);

    useEffect(() => { if (isOpen) setName(''); }, [isOpen]);
    if (!isOpen) return null;

    const generate = () => { if (!busy) onGenerate(name.trim()); };

    return createPortal(
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 80,
                background: 'rgba(0,0,0,0.55)',
                display: 'grid',
                placeItems: 'center',
                padding: 'max(16px, env(safe-area-inset-top, 0px), var(--app-safe-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px), var(--app-safe-bottom, 0px))',
                animation: 'fadeIn .2s ease-out',
            }}
            role="dialog"
            aria-modal="true"
            aria-label={t('mcp.token_generate')}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div
                className="card anim-in"
                style={{
                    width: '100%',
                    maxWidth: 420,
                    background: 'var(--sc)',
                    borderRadius: 28,
                    padding: '24px 22px 20px',
                    boxShadow: '0 12px 32px rgba(0,0,0,.35)',
                }}
            >
                <div className="hrow" style={{ marginBottom: 14 }}>
                    <b style={{ fontSize: 18, color: 'var(--on)' }}>{t('mcp.token_generate')}</b>
                    <button
                        type="button"
                        onClick={onClose}
                        className="btn x"
                        aria-label={t('btn.cancel')}
                        style={{ width: 36, height: 36, padding: 0, borderRadius: '50%', minWidth: 0 }}
                    >
                        <Icon icon={X} size={18} />
                    </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
                    <label className="sub" style={{ margin: 0, fontSize: 12.5, fontWeight: 600 }}>{t('mcp.token_name_label')}</label>
                    <div className="fld" style={{ height: 48, borderRadius: 16, marginTop: 4 }}>
                        <input
                            autoFocus
                            value={name}
                            onChange={e => setName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') generate(); }}
                            maxLength={64}
                            placeholder={t('mcp.token_default_name')}
                            style={{ fontSize: 15 }}
                        />
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={onClose} className="btn x" style={{ flex: 1 }}>{t('btn.cancel')}</button>
                    <button type="button" onClick={generate} disabled={busy} className="btn" style={{ flex: 1 }}>
                        {busy ? <Progress size={14} /> : t('mcp.token_generate')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

const RevealTokenModal: React.FC<{
    value: string | null;
    copied: boolean;
    configCopied: boolean;
    onCopy: () => void;
    onCopyConfig: () => void;
    onClose: () => void;
}> = ({ value, copied, configCopied, onCopy, onCopyConfig, onClose }) => {
    const { t } = useTranslation();
    const isOpen = value !== null;
    useEscape(onClose, isOpen);
    if (!isOpen || value === null) return null;

    return createPortal(
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 80,
                background: 'rgba(0,0,0,0.55)',
                display: 'grid',
                placeItems: 'center',
                padding: 'max(16px, env(safe-area-inset-top, 0px), var(--app-safe-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px), var(--app-safe-bottom, 0px))',
                animation: 'fadeIn .2s ease-out',
            }}
            role="dialog"
            aria-modal="true"
            aria-label={t('mcp.token_once_title')}
        >
            <div
                className="card anim-in"
                style={{
                    width: '100%',
                    maxWidth: 440,
                    background: 'var(--sc)',
                    borderRadius: 28,
                    padding: '24px 22px 20px',
                    boxShadow: '0 12px 32px rgba(0,0,0,.35)',
                }}
            >
                <div className="hrow" style={{ marginBottom: 12 }}>
                    <b style={{ fontSize: 18, color: 'var(--on)' }}>{t('mcp.token_once_title')}</b>
                </div>
                <p className="sub" style={{ margin: '0 0 14px', lineHeight: 1.55 }}>{t('mcp.token_once_desc')}</p>
                <div className="card" style={{ background: 'var(--bg)', padding: '12px 14px', borderRadius: 16, marginBottom: 14 }}>
                    <code style={{ fontSize: 13, wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace', color: 'var(--pri)' }}>
                        {value}
                    </code>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={onCopy} className="btn t" style={{ flex: 1 }}>
                        <Icon icon={copied ? Check : Copy} size={15} />
                        <span>{copied ? t('export.copied') : t('btn.copy')}</span>
                    </button>
                    <button type="button" onClick={onClose} className="btn" style={{ flex: 1 }}>
                        <Icon icon={Check} size={16} />
                        <span>{t('btn.done')}</span>
                    </button>
                </div>
                {/* The token goes into a file on this device. Copying the finished
                    config keeps the one-tap flow without ever putting the credential
                    in a chat window. */}
                <button
                    type="button"
                    onClick={onCopyConfig}
                    className="btn x"
                    style={{ width: '100%', marginTop: 8, minHeight: 44 }}
                >
                    <Icon icon={configCopied ? Check : Copy} size={15} />
                    <span>{configCopied ? t('export.copied') : t('mcp.copy_config')}</span>
                </button>
            </div>
        </div>,
        document.body,
    );
};

const TokenManager: React.FC<{ session: CoreSession }> = ({ session }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const [tokens, setTokens] = useState<ApiToken[] | null>(null);
    const [minting, setMinting] = useState(false);
    const [fresh, setFresh] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [configCopied, setConfigCopied] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [mintOpen, setMintOpen] = useState(false);

    const load = useCallback(async () => {
        if (!session.token) return;
        try {
            setTokens(await coreAuth.listTokens(session.token));
            setError(null);
        } catch (e: any) {
            setError(e?.message ?? String(e));
            setTokens([]);
        }
    }, [session.token]);

    useEffect(() => { void load(); }, [load]);

    const mint = async (name: string) => {
        if (!session.token) return;
        setMinting(true);
        setError(null);
        try {
            const created = await coreAuth.mintToken(session.token, name || t('mcp.token_default_name'));
            setMintOpen(false);
            setFresh(created.token);
            setCopied(false);
            setConfigCopied(false);
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        } finally {
            setMinting(false);
        }
    };

    const startRename = (tk: ApiToken) => {
        setRenamingId(tk.id);
        setRenameValue(tk.name);
        setError(null);
    };

    const saveRename = async () => {
        if (!session.token || !renamingId) return;
        const name = renameValue.trim();
        const id = renamingId;
        setRenamingId(null);
        if (!name) return;
        try {
            await coreAuth.renameToken(session.token, id, name);
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        }
    };

    const revoke = (token: ApiToken) => {
        showDialog('confirm', t('mcp.token_revoke_confirm').replace('{name}', token.name), async () => {
            if (!session.token) return;
            try {
                await coreAuth.revokeToken(session.token, token.id);
                await load();
            } catch (e: any) {
                setError(e?.message ?? String(e));
            }
        });
    };

    const copyFresh = () => {
        if (!fresh) return;
        navigator.clipboard.writeText(fresh).then(() => setCopied(true));
    };

    /**
     * The ready-to-paste client entry, token included.
     *
     * Deliberately a clipboard action and not part of the prompt: the clipboard is
     * local to this device, while a chat transcript leaves the building and is often
     * retained.
     */
    const copyConfig = () => {
        if (!fresh) return;
        const config = {
            mcpServers: {
                'kira-tracker': {
                    type: 'http',
                    url: MCP_ENDPOINT,
                    headers: { Authorization: `Bearer ${fresh}` },
                },
            },
        };
        navigator.clipboard
            .writeText(JSON.stringify(config, null, 2))
            .then(() => setConfigCopied(true));
    };

    if (!session.isSignedIn) {
        return (
            <div className="card" style={{ background: 'var(--sch)', padding: 18 }}>
                <StepHeading n={1} title={t('mcp.tokens_label')} desc={t('mcp.tokens_signin_required')} />
            </div>
        );
    }

    return (
        <div className="card" style={{ background: 'var(--sch)', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="hrow" style={{ alignItems: 'flex-start' }}>
                <StepHeading n={1} title={t('mcp.tokens_label')} desc={t('mcp.tokens_desc')} />
                <button
                    type="button"
                    onClick={() => setMintOpen(true)}
                    className="btn t"
                    style={{ minWidth: 84, padding: '0 14px', height: 40, borderRadius: 20, flex: 'none' }}
                >
                    <Icon icon={Plus} size={15} />
                    <span>{t('mcp.token_generate')}</span>
                </button>
            </div>

            <MintTokenModal isOpen={mintOpen} onClose={() => setMintOpen(false)} onGenerate={mint} busy={minting} />
            <RevealTokenModal
                value={fresh}
                copied={copied}
                configCopied={configCopied}
                onCopy={copyFresh}
                onCopyConfig={copyConfig}
                onClose={() => setFresh(null)}
            />

            {error && <p className="sub" style={{ color: 'var(--err)', margin: 0 }}>{error}</p>}

            <div>
                {tokens === null ? (
                    <p className="sub" style={{ margin: '8px 0' }}><Progress size={14} /> {t('core.loading')}</p>
                ) : tokens.length === 0 ? (
                    <p className="sub" style={{ margin: '8px 0' }}>{t('mcp.tokens_empty')}</p>
                ) : (
                    <div className="list" style={{ marginTop: 6 }}>
                        {tokens.map((tk) => (
                            <div key={tk.id} className="li">
                                <span className="ic p"><Icon icon={KeyRound} size={18} /></span>
                                {renamingId === tk.id ? (
                                    <div style={{ display: 'flex', flex: 1, gap: 6, minWidth: 0 }}>
                                        <input
                                            autoFocus
                                            value={renameValue}
                                            onChange={e => setRenameValue(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setRenamingId(null); }}
                                            maxLength={64}
                                            className="fld"
                                            style={{ height: 40, borderRadius: 14, flex: 1, fontSize: 14 }}
                                            aria-label={t('mcp.token_rename')}
                                        />
                                        <button type="button" onClick={() => void saveRename()} className="btn" style={{ height: 40, padding: '0 12px', minWidth: 0 }}>
                                            <Icon icon={Check} size={15} />
                                        </button>
                                        <button type="button" onClick={() => setRenamingId(null)} className="btn x" style={{ height: 40, padding: '0 8px', minWidth: 0 }}>
                                            <Icon icon={X} size={15} />
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <div className="t">
                                            <b>{tk.name}</b>
                                            <span className="s">{new Date(tk.createdAt).toLocaleDateString()}</span>
                                        </div>
                                        <button type="button" onClick={() => startRename(tk)} className="btn x" style={{ padding: 6, width: 34, height: 34, borderRadius: '50%', minWidth: 0 }}>
                                            <Icon icon={Edit2} size={15} />
                                        </button>
                                        <button type="button" onClick={() => revoke(tk)} className="icon-del" aria-label={t('btn.delete')}>
                                            <Icon icon={Trash2} size={16} />
                                        </button>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

const McpSettings: React.FC<McpSettingsProps> = ({ session, onBack, onSignIn }) => {
    const { t } = useTranslation();
    const endpoint = MCP_ENDPOINT;
    const clientConfig = JSON.stringify({ mcpServers: { hrt: { url: endpoint } } }, null, 2);
    const installPrompt = buildMcpInstallPrompt(endpoint);

    return (
        <div className="pg on long m3e-rise" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
            <HeaderBack title={t('mcp.title')} onBack={onBack} backLabel={t('core.back')} />

            <div className="d-col" style={{ gap: 14 }}>
                <p className="sub" style={{ margin: 0 }}>{t('mcp.intro')}</p>

                {/* Read warning */}
                <div className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: 'var(--errc)', color: 'var(--err)', borderRadius: 20 }}>
                    <span style={{ display: 'inline-flex', flex: 'none', marginTop: 2 }}>
                        <Icon icon={AlertTriangle} size={18} />
                    </span>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>{t('mcp.token_read_warning')}</p>
                </div>

                {/* 1 — a token */}
                <TokenManager session={session} />

                {!session.isSignedIn && (
                    <button type="button" onClick={onSignIn} className="btn" style={{ alignSelf: 'flex-start' }}>
                        {t('core.sign_in')}
                    </button>
                )}

                {/* 2 — install it in one paste */}
                <div className="card" style={{ background: 'var(--sch)', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <StepHeading n={2} title={t('mcp.step_install')} desc={t('mcp.install_desc')} />
                    <CopyRow variant="single" value={installPrompt} hint={t('mcp.install_hint')} />
                    <p className="sub" style={{ margin: 0, fontSize: 12 }}>{t('mcp.endpoint_hint')}</p>
                </div>

                {/* 3 — the config, by hand */}
                <div className="card" style={{ background: 'var(--sch)', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <StepHeading n={3} title={t('mcp.step_config_manual')} desc={t('mcp.config_desc')} />
                    <CopyRow value={clientConfig} hint={t('mcp.config_hint')} />
                </div>

                {/* What the assistant can do — a list */}
                <div>
                    <div className="lab">{t('mcp.tools_label')}</div>
                    <p className="sub" style={{ margin: '0 6px 8px' }}>
                        {t('mcp.tools_desc').replace('{count}', String(MCP_TOOLS.length))}
                    </p>
                    <div className="list">
                        {MCP_TOOLS.map((tool) => (
                            <div key={tool.name} className="li">
                                <span className="ic p" style={{ width: 36, height: 36 }}>
                                    <Icon icon={Check} size={15} />
                                </span>
                                <div className="t">
                                    <b style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13.5 }}>{tool.name}</b>
                                    <span className="s">{t(`mcp.tool.${tool.name}`)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Scope limits */}
                <div>
                    <div className="lab">{t('mcp.scope_label')}</div>
                    <div className="card" style={{ padding: 16 }}>
                        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--on)' }}>{t('mcp.scope_note')}</p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default McpSettings;
