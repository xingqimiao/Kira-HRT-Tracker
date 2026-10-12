import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, AlertTriangle, Check, Copy, Edit2, KeyRound, Plus, Trash2, X } from '../icons';
import { Progress } from '../components/ui';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { coreAuth, type ApiToken } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { MCP_ENDPOINT } from '../constants';
import CopyRow from '../components/CopyRow';
import { buildMcpInstallPrompt } from '../utils/mcpInstallPrompt';

interface McpSettingsProps {
    session: CoreSession;
    onBack: () => void;
    /** Start the Core sign-in, when there is no session to mint a token with. */
    onSignIn: () => void;
}

/**
 * The tools an assistant can call, by name. The **names come from here** and the
 * **count is derived** (`MCP_TOOLS.length`), because `scripts/check-mcp-tools.mjs`
 * compares this list against the tools the server registers and the tables in MCP.md —
 * the count was wrong twice when it was typed into copy, so it is read from this one
 * set instead.
 *
 * Each tool's one-line description is a translation (`mcp.tool.<name>`), not a field
 * here: it is prose a person reads, so it belongs with the copy. It was hardcoded
 * English under the Chinese headings.
 */
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
    { name: 'hrt_sync_state' },
    { name: 'hrt_reference' },
    { name: 'hrt_add_medication' },
    { name: 'hrt_add_lab_result' },
    { name: 'hrt_add_journal_entry' },
    { name: 'hrt_add_dose_template' },
    { name: 'hrt_update_settings' },
    { name: 'hrt_delete_record' },
    // The share tools, grouped at the end because they are the only ones whose effect
    // is visible outside the account — a link anyone can open.
    { name: 'hrt_create_share' },
    { name: 'hrt_list_shares' },
    { name: 'hrt_revoke_share' },
];

const divider = 'border-b border-[var(--color-m3-outline-variant)] ';
const sectionLabel = 'text-xs font-semibold uppercase tracking-wide text-[var(--color-m3-on-surface-variant)] ';
const body = 'text-m3-body-medium leading-relaxed text-[var(--color-m3-on-surface)] ';
const muted = 'text-m3-body-compact leading-relaxed text-[var(--color-m3-on-surface-variant)] ';
const codeBlock =
    'w-full overflow-x-auto rounded-md bg-[var(--color-m3-surface-container)] px-3 py-2 ' +
    'font-mono text-xs leading-relaxed text-[var(--color-m3-on-surface)] whitespace-pre';

/**
 * The step heading: a numbered badge beside a title, so the three steps read as a
 * sequence rather than three more sections. MD3's list rhythm (leading slot, headline,
 * supporting text) is what the whole page is built on now.
 */
const StepHeading: React.FC<{ n: number; title: string; desc?: string }> = ({ n, title, desc }) => (
    <div className="flex items-center gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-m3-primary-container)] text-xs font-semibold tabular-nums text-[var(--color-m3-on-primary-container)]">{n}</span>
        <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--color-m3-on-surface)]">{title}</p>
            {desc && <p className={`mt-0.5 ${muted}`}>{desc}</p>}
        </div>
    </div>
);

/**
 * Token management: mint, list, rename, revoke.
 *
 * The minted value is shown once, in a panel that stays until the user dismisses it,
 * because there is genuinely no way to read it again — the server keeps only a hash.
 * Presenting it in a toast that fades would be the same as losing it.
 */
const TokenManager: React.FC<{ session: CoreSession }> = ({ session }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const [tokens, setTokens] = useState<ApiToken[] | null>(null);
    const [minting, setMinting] = useState(false);
    const [fresh, setFresh] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    // Which token is being renamed, and the in-progress value. Inline rather than a
    // dialog so the row stays in place and the change reads as an edit of that row.
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

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

    const mint = async () => {
        if (!session.token) return;
        setMinting(true);
        setError(null);
        try {
            const created = await coreAuth.mintToken(session.token, t('mcp.token_default_name'));
            setFresh(created.token);
            setCopied(false);
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

    if (!session.isSignedIn) {
        return (
            <section className={`py-4 ${divider}`}>
                <StepHeading n={1} title={t('mcp.tokens_label')} desc={t('mcp.tokens_signin_required')} />
            </section>
        );
    }

    return (
        <section className={`py-4 ${divider}`}>
            <div className="flex items-start justify-between gap-3">
                <StepHeading n={1} title={t('mcp.tokens_label')} desc={t('mcp.tokens_desc')} />
                <button onClick={mint} disabled={minting} className="m3-btn m3-btn-filled m3-btn-sm shrink-0">
                    {minting ? <Progress size={14} /> : <Icon icon={Plus} size={14} />}
                    <span className="ps-1.5">{t('mcp.token_generate')}</span>
                </button>
            </div>

            {error && <p className="mt-3 text-xs text-[var(--color-m3-error)]">{error}</p>}

            {/* The plaintext, once. Stays until dismissed. */}
            {fresh && (
                <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-m3-primary)] p-3">
                    <p className="text-xs font-semibold text-[var(--color-m3-primary)]">{t('mcp.token_once_title')}</p>
                    <p className={`mt-1 ${muted}`}>{t('mcp.token_once_desc')}</p>
                    <div className="mt-2 flex items-start gap-2">
                        <code className={`${codeBlock} flex-1 break-all whitespace-pre-wrap`}>{fresh}</code>
                        <button onClick={copyFresh} className="m3-icon-button shrink-0" aria-label={t('mcp.copy')}>
                            <Icon icon={copied ? Check : Copy} size={16} strokeWidth={1.5} />
                        </button>
                    </div>
                    <button onClick={() => setFresh(null)} className="mt-2 text-xs font-medium text-[var(--color-m3-primary)] hover:underline">
                        {t('mcp.token_once_done')}
                    </button>
                </div>
            )}

            {/* The list. */}
            <div className="mt-2">
                {tokens === null ? (
                    <p className={`flex items-center gap-2 py-3 ${muted}`}><Progress size={14} />{t('core.loading')}</p>
                ) : tokens.length === 0 ? (
                    <p className={`py-3 ${muted}`}>{t('mcp.tokens_empty')}</p>
                ) : (
                    <ul>
                        {tokens.map((tk) => (
                            <li key={tk.id} className={`flex items-center gap-3 py-3 ${divider} last:border-b-0`}>
                                <Icon icon={KeyRound} size={20} strokeWidth={1.5} className={`${muted} shrink-0`} />
                                {renamingId === tk.id ? (
                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                        <input
                                            autoFocus
                                            value={renameValue}
                                            onChange={e => setRenameValue(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setRenamingId(null); }}
                                            maxLength={64}
                                            className="input-base min-w-0 flex-1"
                                            aria-label={t('mcp.token_rename')}
                                        />
                                        <button onClick={() => void saveRename()} className="m3-icon-button shrink-0" aria-label={t('mcp.token_rename_save')}>
                                            <Icon icon={Check} size={16} />
                                        </button>
                                        <button onClick={() => setRenamingId(null)} className="m3-icon-button shrink-0" aria-label={t('mcp.token_rename_cancel')}>
                                            <Icon icon={X} size={16} />
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <div className="min-w-0 flex-1">
                                            <p className={`${body} font-medium truncate`}>{tk.name}</p>
                                            <p className={`text-xs ${muted} tabular-nums`}>
                                                {t('mcp.token_created').replace('{date}', tk.createdAt.slice(0, 10))}
                                                {' · '}
                                                {tk.lastUsedAt
                                                    ? t('mcp.token_last_used').replace('{date}', tk.lastUsedAt.slice(0, 10))
                                                    : t('mcp.token_never_used')}
                                                {' · '}
                                                {tk.expiresAt
                                                    ? t('mcp.token_expires').replace('{date}', tk.expiresAt.slice(0, 10))
                                                    : t('mcp.token_permanent')}
                                            </p>
                                        </div>
                                        <button onClick={() => startRename(tk)} className="m3-icon-button shrink-0" aria-label={t('mcp.token_rename')}>
                                            <Icon icon={Edit2} size={15} strokeWidth={1.5} />
                                        </button>
                                        <button onClick={() => revoke(tk)} className="m3-icon-button shrink-0" aria-label={t('mcp.token_revoke')}>
                                            <Icon icon={Trash2} size={15} strokeWidth={1.5} />
                                        </button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
};

/**
 * How an agent reaches the user's record over MCP.
 *
 * Three steps — token, endpoint, config — then what the assistant can do with it.
 * Built on MD3's list rhythm (leading slot, headline, supporting text) rather than a
 * dense table, and the tool list states each tool once, in plain language.
 */
const McpSettings: React.FC<McpSettingsProps> = ({ session, onBack, onSignIn }) => {
    const { t } = useTranslation();

    const clientConfig = `{
  "mcpServers": {
    "kira-tracker": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer hrt_..." }
    }
  }
}`;

    // One definition of the prompt, shared with the onboarding step that hands
    // the reader the same block — see utils/mcpInstallPrompt.ts for why it reads
    // the way it does.
    const installPrompt = buildMcpInstallPrompt(MCP_ENDPOINT);

    return (
        <div className="relative pb-32">
            <div className="sticky top-0 z-20 bg-[var(--color-m3-surface-dim)] px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)]"
                >
                    <Icon icon={ArrowLeft} size={18} className={`${muted} shrink-0`} />
                    <span className="text-xl font-semibold text-[var(--color-m3-on-surface)]">{t('mcp.title')}</span>
                </button>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 mt-2 max-w-2xl">
                <p className={`pb-2 ${muted}`}>{t('mcp.intro')}</p>

                {/* What the token reaches, stated before the reader makes one: whoever
                    holds it can read every record. It sits at the top so it is read
                    first, not after the mint button. */}
                <div className="mb-2 flex gap-3 rounded-[var(--radius-md)] border border-[var(--color-m3-error)]/40 bg-[var(--color-m3-error)]/8 p-3">
                    <Icon icon={AlertTriangle} size={18} className="mt-0.5 shrink-0 text-[var(--color-m3-error)]" />
                    <p className={body}>{t('mcp.token_read_warning')}</p>
                </div>

                {/* 1 — a token. First because nothing else works without it. */}
                <TokenManager session={session} />

                {!session.isSignedIn && (
                    <button onClick={onSignIn} className="m3-btn m3-btn-filled mt-4">{t('core.sign_in')}</button>
                )}

                {/* 2 — install it in one paste. The endpoint address lives inside the
                    prompt and the manual config, so it needs no step of its own. The
                    prompt comes first because it works without the reader knowing where
                    their client keeps its files. */}
                <section className={`py-4 ${divider}`}>
                    <StepHeading n={2} title={t('mcp.step_install')} desc={t('mcp.install_desc')} />
                    <div className="mt-3">
                        <CopyRow variant="single" value={installPrompt} hint={t('mcp.install_hint')} />
                    </div>
                    <p className={`mt-1 ${muted}`}>{t('mcp.endpoint_hint')}</p>
                </section>

                {/* 3 — the config, by hand. */}
                <section className={`py-4 ${divider}`}>
                    <StepHeading n={3} title={t('mcp.step_config_manual')} desc={t('mcp.config_desc')} />
                    <div className="mt-3">
                        <CopyRow value={clientConfig} hint={t('mcp.config_hint')} />
                    </div>
                </section>

                {/* What the assistant can do — a list, one line each. */}
                <section className={`py-4 ${divider}`}>
                    <p className={sectionLabel}>{t('mcp.tools_label')}</p>
                    {/* The count comes from the list above, not from the copy: see the
                        note on `MCP_TOOLS` for why a typed number was wrong twice. */}
                    <p className={`mt-1 ${muted}`}>{t('mcp.tools_desc').replace('{count}', String(MCP_TOOLS.length))}</p>
                    <ul className="mt-3">
                        {MCP_TOOLS.map((tool) => (
                            <li key={tool.name} className={`flex gap-3 py-2.5 ${divider} last:border-b-0`}>
                                <Icon icon={Check} size={16} className="mt-0.5 shrink-0 text-[var(--color-m3-primary)]" />
                                <div className="min-w-0">
                                    <p className="font-mono text-xs text-[var(--color-m3-on-surface)]">{tool.name}</p>
                                    <p className={`mt-0.5 ${muted}`}>{t(`mcp.tool.${tool.name}`)}</p>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>

                {/* What the token deliberately cannot do. Stated because "everything the
                    app can do is available over MCP" is only true with named exceptions,
                    and an unstated exception is worse than no principle. */}
                <section className="py-4">
                    <p className={sectionLabel}>{t('mcp.scope_label')}</p>
                    <p className={`mt-1 ${body}`}>{t('mcp.scope_note')}</p>
                </section>
            </div>
        </div>
    );
};

export default McpSettings;
