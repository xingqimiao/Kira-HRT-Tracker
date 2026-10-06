import React from 'react';
import Icon from '../components/Icon';
import Switch from '../components/Switch';
import { ArrowLeft, Check } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useVial } from '../contexts/VialContext';
import { AppTheme, ChartStyle, KeyColor } from '../constants';

interface AppearanceSettingsProps {
    theme: AppTheme;
    setTheme: (theme: AppTheme) => void;
    keyColor: KeyColor;
    setKeyColor: (color: KeyColor) => void;
    /** Whether the overview draws the dose-day grid. */
    showHeatmap: boolean;
    setShowHeatmap: (v: boolean) => void;
    /** How the overview chart draws the primary series. */
    chartStyle: ChartStyle;
    setChartStyle: (s: ChartStyle) => void;
    /** Whether E2/T readings show a decimal place. */
    readingDecimals: boolean;
    setReadingDecimals: (v: boolean) => void;
    onBack: () => void;
}

/** The chart's draw styles, in display order — see `ChartStyle`. */
const CHART_STYLES: readonly ChartStyle[] = ['line', '1d'];

const divider = 'border-b border-[var(--color-m3-outline-variant)] ';
const rowLabel = 'text-m3-body-medium text-[var(--color-m3-on-surface)] ';
const muted = 'text-[var(--color-m3-on-surface-variant)] ';

const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({
    theme, setTheme, keyColor, setKeyColor,
    showHeatmap, setShowHeatmap, chartStyle, setChartStyle,
    readingDecimals, setReadingDecimals, onBack,
}) => {
    const { t } = useTranslation();
    // The vial owns its own preference; the page reads it from the provider
    // rather than taking a prop, the same way every other owner of it does.
    const { showVial, setShowVial } = useVial();

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
                        className={`w-full flex items-center justify-between py-4 ${divider}last:border-b-0 text-start`}
                    >
                        <span className={`text-m3-body-medium ${theme === value
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
                    <span className={rowLabel}>{t(`settings.key_color.${keyColor}`)}</span>
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

            {/* Overview display options. These are looks, not data: how the
                overview is drawn, so they belong with the theme rather than with
                the record settings they used to sit among. */}
            <div className="mx-auto w-full px-6 md:px-8 max-w-2xl">
                <p className="pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-m3-on-surface-variant)] ">
                    {t('settings.group.display')}
                </p>

                <div className={`${divider} w-full flex items-center justify-between py-4`}>
                    <div>
                        <p className={rowLabel}>{t('settings.blood_vial')}</p>
                        <p className={`text-xs ${muted} mt-0.5`}>{t('settings.blood_vial_desc')}</p>
                    </div>
                    <Switch checked={showVial} onChange={setShowVial} />
                </div>

                <div className={`${divider} w-full flex items-center justify-between py-4`}>
                    <div>
                        <p className={rowLabel}>{t('settings.reading_decimals')}</p>
                        <p className={`text-xs ${muted} mt-0.5`}>{t('settings.reading_decimals_desc')}</p>
                    </div>
                    <Switch checked={readingDecimals} onChange={setReadingDecimals} />
                </div>

                {/* How the overview chart draws the primary series. The candle
                    option is a *request* — a window too wide to honour it draws
                    a coarser interval, and the chart's header chip says which. */}
                <div className={`${divider} w-full py-4`}>
                    <p className={rowLabel}>{t('settings.chart_style')}</p>
                    <p className={`text-xs ${muted} mt-0.5`}>{t('settings.chart_style_desc')}</p>
                    <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label={t('settings.chart_style')}>
                        {CHART_STYLES.map(s => (
                            <button
                                key={s}
                                type="button"
                                aria-pressed={chartStyle === s}
                                onClick={() => setChartStyle(s)}
                                className={`m3-btn m3-btn-sm ${chartStyle === s ? 'm3-btn-filled' : 'm3-btn-outlined'}`}
                            >
                                {t(`settings.chart_style.${s}`)}
                            </button>
                        ))}
                    </div>
                </div>

                {/* The dose grid. Off and unavailable while the candle view is on:
                    that view pairs the chart with the dose list (its "order book"),
                    so the grid's switch is disabled and the hint says why rather
                    than leaving a control that silently does nothing. */}
                <div className={`${divider} w-full flex items-center justify-between py-4`}>
                    <div>
                        <p className={rowLabel}>{t('settings.dose_heatmap')}</p>
                        <p className={`text-xs ${muted} mt-0.5`}>
                            {chartStyle !== 'line' ? t('settings.dose_heatmap_candle') : t('settings.dose_heatmap_desc')}
                        </p>
                    </div>
                    <Switch checked={showHeatmap} onChange={setShowHeatmap} disabled={chartStyle !== 'line'} />
                </div>
            </div>
        </div>
    );
};

export default AppearanceSettings;
