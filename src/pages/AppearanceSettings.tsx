import React from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, Check } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { AppTheme, KeyColor } from '../constants';

interface AppearanceSettingsProps {
    theme: AppTheme;
    setTheme: (theme: AppTheme) => void;
    keyColor: KeyColor;
    setKeyColor: (color: KeyColor) => void;
    onBack: () => void;
}

const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({ theme, setTheme, keyColor, setKeyColor, onBack }) => {
    const { t } = useTranslation();

    const options = [
        { value: 'system' as const, labelKey: 'theme.system' },
        { value: 'light' as const, labelKey: 'theme.light' },
        { value: 'dark' as const, labelKey: 'theme.dark' },
    ];

    // The two tuned swatches. Fixed identity tokens, not the role tokens: the
    // roles swap when the choice is applied, so a swatch read from them would
    // repaint itself as the other option the moment you picked it.
    const keyColors: { id: KeyColor; background: string }[] = [
        { id: 'pink', background: 'var(--color-m3-key-pink)' },
        { id: 'blue', background: 'var(--color-m3-key-blue)' },
    ];

    return (
        <div className="relative space-y-4 pb-32">
            <div className="sticky top-0 z-20 bg-[var(--color-m3-surface-dim)]  px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={ArrowLeft} size={18} className="text-[var(--color-m3-on-surface-variant)]  shrink-0" />
                    <span className="text-xl font-semibold text-[var(--color-m3-on-surface)] ">
                        {t('settings.theme')}
                    </span>
                </button>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 max-w-2xl">
                {options.map(({ value, labelKey }) => (
                    <button
                        key={value}
                        onClick={() => setTheme(value)}
                        className="w-full flex items-center justify-between py-4 border-b border-[var(--color-m3-outline-variant)]  last:border-b-0 text-start"
                    >
                        <span className={`text-[0.9375rem] ${theme === value
                            ? 'font-semibold text-[var(--color-m3-on-surface)] '
                            : 'text-[var(--color-m3-on-surface)] '
                        }`}>{t(labelKey)}</span>
                        {theme === value && (
                            <Icon icon={Check} size={16} className="text-[var(--color-m3-primary)]  shrink-0" />
                        )}
                    </button>
                ))}
            </div>

            <div className="mx-auto w-full px-6 md:px-8 max-w-2xl">
                <p className="pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-m3-on-surface-variant)] ">
                    {t('settings.key_color')}
                </p>
                <div className="w-full flex items-center justify-between py-4">
                    <span className="text-[0.9375rem] text-[var(--color-m3-on-surface)] ">
                        {t(`settings.key_color.${keyColor}`)}
                    </span>
                    <div className="flex items-center gap-2.5">
                        {keyColors.map(({ id, background }) => (
                            <button
                                key={id}
                                onClick={() => setKeyColor(id)}
                                aria-label={t(`settings.key_color.${id}`)}
                                aria-pressed={keyColor === id}
                                className={`h-7 w-7 shrink-0 rounded-full border border-[var(--color-m3-outline-variant)]  ${
                                    keyColor === id
                                        ? 'ring-2 ring-[var(--color-m3-primary)] ring-offset-2 ring-offset-[var(--color-m3-surface-dim)] '
                                        : ''
                                }`}
                                style={{ background }}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AppearanceSettings;
