import React, { useState } from 'react';
import Icon from './Icon';
import { X, Loader2 } from '../icons';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';

interface AuthModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
    const [isLogin, setIsLogin] = useState(true);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const { login, register } = useAuth();
    const { t } = useTranslation();

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            if (isLogin) {
                await login(username, password);
            } else {
                await register(username, password);
            }
            onClose();
            setUsername('');
            setPassword('');
        } catch (err: any) {
            setError(err.message || t('error.generic'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay">
            <div className="modal-shell">
            <div className="modal-card overflow-hidden p-0">
                <div className="flex items-center justify-between px-5 pt-5 pb-2">
                    <h2 className="modal-title mb-0">
                        {isLogin ? t('auth.sign_in') : t('auth.sign_up')}
                    </h2>
                    <button onClick={onClose} className="p-1 text-muted hover:text-body">
                        <Icon icon={X} size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="px-5 pb-5 pt-1 space-y-3">
                    {error && (
                        <div className="p-2.5 text-xs text-cos-error  callout border-cos-error ">
                            {error}
                        </div>
                    )}

                    <div className="space-y-1.5">
                        <label className="text-sm text-muted">{t('auth.username')}</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="input-base"
                            placeholder={t('auth.username_placeholder')}
                            required
                        />
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-sm text-muted">{t('auth.password')}</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="input-base"
                            placeholder={t('auth.password_placeholder')}
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="btn-primary w-full mt-1"
                    >
                        {loading && <Icon icon={Loader2} size={16} className="animate-spin" />}
                        {isLogin ? t('auth.sign_in') : t('auth.sign_up')}
                    </button>

                    <div className="pt-2 text-center text-sm text-muted">
                        {isLogin ? t('auth.no_account') : t('auth.has_account')}{' '}
                        <button
                            type="button"
                            onClick={() => { setIsLogin(!isLogin); setError(null); }}
                            className="text-[var(--color-m3-primary)]  hover:underline"
                        >
                            {isLogin ? t('auth.go_register') : t('auth.go_login')}
                        </button>
                    </div>
                </form>
            </div>
            </div>
        </div>
    );
};

export default AuthModal;
