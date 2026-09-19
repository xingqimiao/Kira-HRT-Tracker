import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, Check, Copy, KeyRound, Loader2, Plus, Trash2 } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { coreAuth, type ApiToken } from '../services/coreAuth';
import type { CoreSession } from '../hooks/useCoreSession';
import { MCP_ENDPOINT } from '../constants';

interface McpSettingsProps {
    session: CoreSession;
    onBack: () => void;
    /** Start the Core sign-in, when there is no session to mint a token with. */
    onSignIn: () => void;
}

/**
 * The twelve tools, mirrored from `server/src/mcp.ts`.
 *
 * Described the way a documented MCP server describes its own — a table of tool,
 * input and what it returns — rather than as a bare list of names. A name alone
 * tells a reader nothing about what an agent can do with it, which was the complaint
 * that produced this rewrite.
 */
const MCP_TOOLS: { name: string; input: string; returns: string }[] = [
    { name: 'hrt_get_timeline', input: 'limit?', returns: 'Doses and labs merged, newest first' },
    { name: 'hrt_list_medications', input: 'limit?', returns: 'Logged doses' },
    { name: 'hrt_list_labs', input: 'limit?', returns: 'Lab results' },
    { name: 'hrt_predict_levels', input: 'at?', returns: 'Modelled concentration at a time' },
    { name: 'hrt_check_advisories', input: '—', returns: 'Any dosage advisory the app would show' },
    { name: 'hrt_get_settings', input: '—', returns: 'Body weight, mode, calibration' },
    { name: 'hrt_add_medication', input: 'route, ester, dose_mg, at', returns: 'The created dose' },
    { name: 'hrt_add_lab_result', input: 'value, unit, at', returns: 'The created lab result' },
    { name: 'hrt_update_settings', input: 'any setting field', returns: 'The updated settings' },
    { name: 'hrt_delete_record', input: 'kind, id', returns: 'Confirmation' },
    { name: 'hrt_sync_state', input: '—', returns: 'Full record state' },
    { name: 'hrt_reference', input: '—', returns: 'Routes, esters and units the app accepts' },
    // The share tools, grouped at the end because they are the only ones whose effect
    // is visible outside the account — a link anyone can open.
    { name: 'hrt_create_share', input: 'expires_in_hours, password?, live?, limit?', returns: 'A URL, shown once' },
    { name: 'hrt_list_shares', input: '—', returns: 'What is currently published' },
    { name: 'hrt_revoke_share', input: 'id', returns: 'Confirmation' },
];

const divider = 'border-b border-[var(--color-m3-outline-variant)] ';
const sectionLabel = 'text-xs font-semibold text-[var(--color-m3-on-surface-variant)] ';
const body = 'text-[0.9375rem] leading-relaxed text-[var(--color-m3-on-surface)] ';
const muted = 'text-[0.8125rem] leading-relaxed text-[var(--color-m3-on-surface-variant)] ';
const codeBlock =
    'w-full overflow-x-auto rounded-md bg-[var(--color-m3-surface-container)] px-3 py-2 ' +
    'font-mono text-xs leading-relaxed text-[var(--color-m3-on-surface)] whitespace-pre';

/**
 * A code value with a copy control. `hint` is the caption; after a copy it becomes
 * the confirmation, so the control needs no label of its own.
 */
const CopyRow: React.FC<{ value: string; hint: string }> = ({ value, hint }) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const copy = () => {
        navigator.clipboard.writeText(value).then(() => {
            if (timerRef.current) clearTimeout(timerRef.current);
            setCopied(true);
            timerRef.current = setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <div className="py-4">
            <div className="flex items-start gap-3">
                <code className={`${codeBlock} flex-1`}>{value}</code>
                <button
                    onClick={copy}
                    className="m3-icon-button shrink-0"
                    aria-label={copied ? t('mcp.copied') : t('mcp.copy')}
                >
                    <Icon icon={copied ? Check : Copy} size={16} strokeWidth={1.5} />
                </button>
            </div>
            <p className={`mt-2 ${muted}`}>{copied ? t('mcp.copied') : hint}</p>
        </div>
    );
};

/**
 * Token management: mint, list, revoke.
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
            const created = await coreAuth.mintToken(session.token, 'agent');
            setFresh(created.token);
            setCopied(false);
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        } finally {
            setMinting(false);
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
                <p className={sectionLabel}>{t('mcp.tokens_label')}</p>
                <p className={`mt-1 ${muted}`}>{t('mcp.tokens_signin_required')}</p>
            </section>
        );
    }

    return (
        <section className={`py-4 ${divider}`}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className={sectionLabel}>{t('mcp.tokens_label')}</p>
                    <p className={`mt-1 ${muted}`}>{t('mcp.tokens_desc')}</p>
                </div>
                <button
                    onClick={mint}
                    disabled={minting}
                    className="btn-primary shrink-0 disabled:opacity-50"
                >
                    {minting ? <Icon icon={Loader2} size={14} className="animate-spin" /> : <Icon icon={Plus} size={14} />}
                    {t('mcp.token_generate')}
                </button>
            </div>

            {error && <p className="mt-3 text-xs text-cos-error">{error}</p>}

            {/* The plaintext, once. Stays until dismissed. */}
            {fresh && (
                <div className="mt-4 rounded-md border border-[var(--color-m3-primary)] p-3">
                    <p className="text-xs font-semibold text-[var(--color-m3-primary)]">
                        {t('mcp.token_once_title')}
                    </p>
                    <p className={`mt-1 ${muted}`}>{t('mcp.token_once_desc')}</p>
                    <div className="mt-2 flex items-start gap-3">
                        <code className={`${codeBlock} flex-1 break-all whitespace-pre-wrap`}>{fresh}</code>
                        <button onClick={copyFresh} className="m3-icon-button shrink-0" aria-label={t('mcp.copy')}>
                            <Icon icon={copied ? Check : Copy} size={16} strokeWidth={1.5} />
                        </button>
                    </div>
                    <button
                        onClick={() => setFresh(null)}
                        className="mt-2 text-xs text-[var(--color-m3-primary)] hover:underline"
                    >
                        {t('mcp.token_once_done')}
                    </button>
                </div>
            )}

            {/* The list. */}
            <div className="mt-4">
                {tokens === null ? (
                    <p className={`flex items-center gap-2 ${muted}`}>
                        <Icon icon={Loader2} size={14} className="animate-spin" />{t('core.loading')}
                    </p>
                ) : tokens.length === 0 ? (
                    <p className={muted}>{t('mcp.tokens_empty')}</p>
                ) : (
                    <ul>
                        {tokens.map((tk) => (
                            <li key={tk.id} className={`flex items-center gap-3 py-3 ${divider} last:border-b-0`}>
                                <Icon icon={KeyRound} size={16} strokeWidth={1.5} className={`${muted} shrink-0`} />
                                <div className="flex-1 min-w-0">
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
                                <button
                                    onClick={() => revoke(tk)}
                                    className="m3-icon-button shrink-0"
                                    aria-label={t('mcp.token_revoke')}
                                >
                                    <Icon icon={Trash2} size={15} strokeWidth={1.5} />
                                </button>
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
 * Three steps and a tool table, modelled on how documented MCP servers present
 * themselves (`reicon.dev/docs/mcp` is the reference this was asked to follow):
 * token, endpoint, config — then the tools. The previous version listed the tool
 * names in a wrapped row of chips and left "how do I actually connect this" entirely
 * to the reader.
 *
 * The page also **manages tokens** now rather than only describing them, which is
 * what makes it a settings page instead of a help article.
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

    /**
     * The install prompt: paste this into an AI assistant and it configures itself.
     *
     * Written to be self-contained, because the reader is an assistant that has never
     * heard of this service. So it states the transport, the auth header, where the
     * config lives per client, how to tell it worked, and — importantly — what the token
     * really is: a full credential. The prompt says plainly that it reads and writes the
     * records with no browser session, and that signing out does not stop it.
     *
     * The token is left as a placeholder on purpose. A prompt is often pasted into a chat
     * that keeps history, and a real token in a transcript is a leaked token.
     */
    const installPrompt = [
        'Add an MCP server to my AI client by editing its configuration file yourself.',
        '',
        `Server name: kira-tracker`,
        `Transport:  Streamable HTTP (POST only)`,
        `URL:        ${MCP_ENDPOINT}`,
        'Auth:       header \`Authorization: Bearer <TOKEN>\`',
        '',
        'Steps:',
        '1. Find my client\'s MCP config file and show me the path before you change it.',
        '   Common locations: claude_desktop_config.json for Claude Desktop,',
        '   .cursor/mcp.json for Cursor, .vscode/mcp.json for VS Code.',
        '2. Add this entry under "mcpServers":',
        '',
        '   {',
        '     "kira-tracker": {',
        '       "type": "http",',
        `       "url": "${MCP_ENDPOINT}",`,
        '       "headers": { "Authorization": "Bearer <TOKEN>" }',
        '     }',
        '   }',
        '',
        '3. Replace <TOKEN> with the token I give you. Ask me for it if I have not.',
        '4. Restart the client, then call hrt_reference to confirm it works. That tool',
        '   needs no records and no unlock, so it is the right one to test with.',
        '',
        'Two things to expect:',
        '- The token is a full credential for my records: it reads and writes them with no',
        '  browser session and no unlock, and signing out does not stop it. Only revoking',
        '  the token or changing my password does.',
        '- hrt_create_share publishes a link that anyone can open. Confirm with me before',
        '  calling it, and propose an expiry rather than picking one silently.',
        '',
        'Start with hrt_reference to learn the accepted routes, esters and units, then',
        'hrt_get_timeline to see what I have already logged.',
    ].join('\n');

    return (
        <div className="relative pb-32">
            <div className="sticky top-0 z-20 bg-[var(--color-m3-surface-dim)] px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={ArrowLeft} size={18} className={`${muted} shrink-0`} />
                    <span className="text-xl font-semibold text-[var(--color-m3-on-surface)] ">
                        {t('mcp.title')}
                    </span>
                </button>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 mt-4 max-w-2xl">
                <p className={`pb-2 ${muted}`}>{t('mcp.intro')}</p>

                {/* 1 — a token. First because nothing else works without it. */}
                <TokenManager session={session} />

                {!session.isSignedIn && (
                    <button onClick={onSignIn} className="btn-primary mt-4">
                        {t('core.sign_in')}
                    </button>
                )}

                {/* 2 — where the client points. */}
                <section className={`py-4 ${divider}`}>
                    <p className={sectionLabel}>{t('mcp.step_endpoint')}</p>
                    <CopyRow value={MCP_ENDPOINT} hint={t('mcp.endpoint_hint')} />
                </section>

                {/* 3 — the config. The prompt first, because it is the path that works
                    without the reader knowing where their client keeps its files. */}
                <section className={`py-4 ${divider}`}>
                    <p className={sectionLabel}>{t('mcp.step_install')}</p>
                    <p className={`mt-1 ${muted}`}>{t('mcp.install_desc')}</p>
                    <CopyRow value={installPrompt} hint={t('mcp.install_hint')} />
                </section>

                {/* 3 — the config. */}
                <section className={`py-4 ${divider}`}>
                    <p className={sectionLabel}>{t('mcp.step_config_manual')}</p>
                    <p className={`mt-1 ${muted}`}>{t('mcp.config_desc')}</p>
                    <CopyRow value={clientConfig} hint={t('mcp.config_hint')} />
                </section>

                {/* The tools, as a table. */}
                <section className={`py-4 ${divider}`}>
                    <p className={sectionLabel}>{t('mcp.tools_label')}</p>
                    <p className={`mt-1 ${muted}`}>{t('mcp.tools_desc')}</p>
                    <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-start text-xs">
                            <thead>
                                <tr className={`${muted} ${divider}`}>
                                    <th className="text-start font-medium py-2 pe-3">{t('mcp.col_tool')}</th>
                                    <th className="text-start font-medium py-2 pe-3">{t('mcp.col_input')}</th>
                                    <th className="text-start font-medium py-2">{t('mcp.col_returns')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {MCP_TOOLS.map((tool) => (
                                    <tr key={tool.name} className={`${divider} last:border-b-0`}>
                                        <td className="py-2 pe-3 font-mono text-[var(--color-m3-on-surface)] whitespace-nowrap">{tool.name}</td>
                                        <td className={`py-2 pe-3 ${muted} whitespace-nowrap`}>{tool.input}</td>
                                        <td className={`py-2 ${muted}`}>{tool.returns}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* The honest caveat. */}
                <section className="py-4">
                    <p className="text-xs font-semibold text-cos-warning">{t('mcp.requirement_label')}</p>
                    <p className={`mt-1 ${body}`}>{t('mcp.requirement_desc')}</p>
                </section>
            </div>
        </div>
    );
};

export default McpSettings;
