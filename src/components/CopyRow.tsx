import React, { useRef, useState } from 'react';
import Icon from './Icon';
import { Check, Copy } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * A value with a copy control. Two heights, same shape (value left, copy right):
 *
 *  - `block` (default) shows the whole value in a wrapped, scrollable code well —
 *    right for the client config JSON, which a reader may want to read in full.
 *  - `single` keeps the value on ONE line (no wrap) in a one-line-high box that
 *    scrolls sideways — right for the install prompt, which is a paragraph of prose
 *    shown only so the reader sees it exists; a tall scroll box made the step heavy.
 *
 * `hint` is the caption; after a copy it becomes the confirmation.
 *
 * Shared by the AI-assistant settings page and the onboarding step that introduces it.
 */
const CopyRow: React.FC<{ value: string; hint: string; variant?: 'block' | 'single' }> = ({ value, hint, variant = 'block' }) => {
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

    if (variant === 'single') {
        return (
            <div className="py-1">
                <div className="flex items-center gap-3">
                    {/* One line, scrolled rather than wrapped: the whole value is still
                        selectable and copyable, but it occupies a single row. `nowrap`
                        (not `pre`) so the prompt's own newlines collapse to spaces too,
                        keeping it to one line. */}
                    <code
                        className="w-full max-w-full flex-1 select-text overflow-x-auto scrollbar-hide whitespace-nowrap rounded-md
                            bg-[var(--color-m3-surface-container)] px-3 py-2 font-mono text-xs leading-5
                            text-[var(--color-m3-on-surface)]"
                    >
                        {value}
                    </code>
                    <button onClick={copy} className="m3-icon-button shrink-0" aria-label={copied ? t('mcp.copied') : t('mcp.copy')}>
                        <Icon icon={copied ? Check : Copy} size={16} strokeWidth={1.5} />
                    </button>
                </div>
                <p className="mt-2 text-m3-body-compact leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                    {copied ? t('mcp.copied') : hint}
                </p>
            </div>
        );
    }

    return (
        <div className="py-4">
            <div className="flex items-start gap-3">
                {/* Wrapped rather than scrolled sideways: the install prompt is a
                    page of prose, and reading it through a 40-character window was
                    the one thing that made it look un-copyable. Bounded in height
                    so a long prompt cannot push the controls off the screen. */}
                <code
                    className="w-full max-w-full flex-1 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md
                        bg-[var(--color-m3-surface-container)] px-3 py-2 font-mono text-xs leading-relaxed
                        text-[var(--color-m3-on-surface)] max-h-72"
                >
                    {value}
                </code>
                <button
                    onClick={copy}
                    className="m3-icon-button shrink-0"
                    aria-label={copied ? t('mcp.copied') : t('mcp.copy')}
                >
                    <Icon icon={copied ? Check : Copy} size={16} strokeWidth={1.5} />
                </button>
            </div>
            <p className="mt-2 text-m3-body-compact leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                {copied ? t('mcp.copied') : hint}
            </p>
        </div>
    );
};

export default CopyRow;
