import { useState, useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { AdaptiveSheet } from '../ui/proto';

interface PasswordInputModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (pw: string) => void;
    title?: string;
    description?: string;
    error?: string | null;
    loading?: boolean;
    /** Mask the input as a password field (defaults to the legacy visible text). */
    masked?: boolean;
}

/**
 * The backup password prompt, on the same AdaptiveSheet as every other dialog.
 *
 * It used to carry the retired `modal-overlay`/`modal-card` shell, so the one
 * step that opens an encrypted backup looked like it came from the previous
 * build while the import page around it was M3E. Escape and system back are the
 * sheet's own concern now, not this component's duplicated handlers.
 */
const PasswordInputModal = ({ isOpen, onClose, onConfirm, title, description, error, loading, masked }: PasswordInputModalProps) => {
    const { t } = useTranslation();
    const [password, setPassword] = useState("");

    useEffect(() => {
        if (isOpen) setPassword("");
    }, [isOpen]);

    const submit = () => { if (password && !loading) onConfirm(password); };

    return (
        <AdaptiveSheet
            open={isOpen}
            onClose={onClose}
            title={title ?? t('import.password_title')}
            closeLabel={t('btn.cancel')}
            footer={
                <div className="hrow" style={{ gap: 8 }}>
                    <button type="button" onClick={onClose} className="btn x" style={{ flex: 1 }}>
                        {t('btn.cancel')}
                    </button>
                    <button type="button" onClick={submit} disabled={!password || loading} className="btn" style={{ flex: 1 }}>
                        {t('btn.ok')}
                    </button>
                </div>
            }
        >
            <div className="d-col" style={{ gap: 12 }}>
                <p className="sub" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
                    {description ?? t('import.password_desc')}
                </p>
                <div className="fld" style={{ height: 48, borderRadius: 16 }}>
                    <input
                        autoFocus
                        type={masked ? 'password' : 'text'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                        placeholder={t('auth.password')}
                        autoComplete="current-password"
                        style={{ fontSize: 15 }}
                    />
                </div>
                {error && (
                    <p className="sub" role="alert" style={{ color: 'var(--err)', margin: 0 }}>
                        {error}
                    </p>
                )}
            </div>
        </AdaptiveSheet>
    );
};

export default PasswordInputModal;
