import React, { useRef, useState } from 'react';
import Icon from './Icon';
import { Check, Copy } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * A code value with a copy control. `hint` is the caption; after a copy it becomes
 * the confirmation, so the control needs no label of its own.
 *
 * Shared by the AI-assistant settings page and the onboarding step that
 * introduces it, because both hand the reader the same kind of one-paste block —
 * an endpoint, a client config, and the install prompt.
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
