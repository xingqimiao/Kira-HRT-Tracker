import React from 'react';
import Icon from '../components/Icon';
import Switch from '../components/Switch';
import { Check } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { AppTheme, ChartStyle, KeyColor } from '../constants';
import { ConnectedButtonGroup, HeaderBack, SegmentedList, SegmentedListItem } from '../ui/proto';

interface AppearanceSettingsProps {
    theme: AppTheme;
    setTheme: (theme: AppTheme) => void;
    keyColor: KeyColor;
    setKeyColor: (color: KeyColor) => void;
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

const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({
    theme, setTheme, keyColor, setKeyColor,
    chartStyle, setChartStyle,
    readingDecimals, setReadingDecimals, onBack,
}) => {
    const { t } = useTranslation();

    const options = [
        { value: 'system' as const, labelKey: 'theme.system' },
        { value: 'light' as const, labelKey: 'theme.light' },
        { value: 'dark' as const, labelKey: 'theme.dark' },
    ];

    // Fixed identity tokens, not role tokens: the roles swap when the choice is
    // applied, so a swatch read from them would repaint as the other option.
    const keyColors: { id: KeyColor; background: string }[] = [
        { id: 'pink', background: 'var(--color-m3-key-pink)' },
        { id: 'blue', background: 'var(--color-m3-key-blue)' },
    ];

    return (
        <div className="pg on long" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
            <HeaderBack title={t('settings.theme')} onBack={onBack} backLabel={t('core.back')} />

            <SegmentedList label={t('settings.theme')}>
                {options.map(({ value, labelKey }) => {
                    const active = theme === value;
                    return (
                        <SegmentedListItem
                            key={value}
                            title={t(labelKey)}
                            active={active}
                            leadingTone={active ? 'primary' : 'default'}
                            trailing={active ? <Icon icon={Check} size={20} /> : undefined}
                            aria-pressed={active}
                            onClick={() => setTheme(value)}
                        />
                    );
                })}
            </SegmentedList>

            <div className="lab">{t('settings.key_color')}</div>
            <SegmentedList label={t('settings.key_color')}>
                <div className="li" style={{ cursor: 'default' }}>
                    <div className="t">
                        <b>{t(`settings.key_color.${keyColor}`)}</b>
                        <span className="s">{t('settings.key_color')}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        {keyColors.map(({ id, background }) => (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setKeyColor(id)}
                                aria-label={t(`settings.key_color.${id}`)}
                                aria-pressed={keyColor === id}
                                className="chip"
                                style={{
                                    width: 34,
                                    height: 34,
                                    padding: 0,
                                    borderRadius: '50%',
                                    background,
                                    boxShadow: keyColor === id ? '0 0 0 3px var(--bg), 0 0 0 5px var(--pri)' : 'inset 0 0 0 1px rgba(0,0,0,.12)',
                                    transition: 'box-shadow .25s, transform .25s cubic-bezier(.3,1.7,.5,1)',
                                    transform: keyColor === id ? 'scale(1.06)' : 'none',
                                }}
                            />
                        ))}
                    </div>
                </div>
            </SegmentedList>

            <div className="lab">{t('settings.group.display')}</div>
            <SegmentedList label={t('settings.group.display')}>
                <div className="li" style={{ cursor: 'default' }}>
                    <div className="t">
                        <b>{t('settings.reading_decimals')}</b>
                        <span className="s" style={{ whiteSpace: 'normal' }}>{t('settings.reading_decimals_desc')}</span>
                    </div>
                    <Switch checked={readingDecimals} onChange={setReadingDecimals} />
                </div>
            </SegmentedList>

            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                    <b style={{ fontSize: 15 }}>{t('settings.chart_style')}</b>
                    <p className="sub" style={{ margin: '3px 0 0', fontSize: 12 }}>{t('settings.chart_style_desc')}</p>
                </div>
                <ConnectedButtonGroup
                    options={CHART_STYLES.map(s => ({ value: s, label: t(`settings.chart_style.${s}`) }))}
                    value={chartStyle}
                    onChange={setChartStyle}
                    label={t('settings.chart_style')}
                />
            </div>
        </div>
    );
};

export default AppearanceSettings;
