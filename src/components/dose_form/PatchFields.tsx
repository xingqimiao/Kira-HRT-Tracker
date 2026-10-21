import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Icon } from '../../ui/SvgDefs';

interface PatchFieldsProps {
    patchMode: 'dose' | 'rate';
    setPatchMode: (val: 'dose' | 'rate') => void;
    patchWearDays: string;
    setPatchWearDays: (val: string) => void;
}

const WEAR_PRESETS = ['3.5', '7'];

/**
 * Patch-specific plan fields, in the same `.list` / `.li` / `.cg-inner`
 * vocabulary as the add-dose panel. The old `FieldRow` / `ChipRow` controls were
 * a second visual system; the plan editor now shares the record editor's rows.
 */
const PatchFields: React.FC<PatchFieldsProps> = ({
    patchMode,
    setPatchMode,
    patchWearDays,
    setPatchWearDays,
}) => {
    const { t } = useTranslation();

    return (
        <div className="list">
            <div className="li col-li">
                <div className="li-row">
                    <div className="ic p"><Icon id="patch" /></div>
                    <div className="tx">
                        <div className="t">{t('m3e.field.patch_mode')}</div>
                        <div className="s">{t('m3e.field.patch_mode_desc')}</div>
                    </div>
                </div>
                <div className="cg-inner">
                    <button type="button" className={patchMode === 'rate' ? 'on' : ''} onClick={() => setPatchMode('rate')}>
                        {t('m3e.field.patch_rate')}
                    </button>
                    <button type="button" className={patchMode === 'dose' ? 'on' : ''} onClick={() => setPatchMode('dose')}>
                        {t('m3e.field.patch_total')}
                    </button>
                </div>
            </div>

            <div className="li col-li">
                <div className="li-row">
                    <div className="ic"><Icon id="clock" /></div>
                    <div className="tx">
                        <div className="t">{t('m3e.field.patch_wear')}</div>
                        <div className="s">{t('m3e.field.patch_wear_desc')}</div>
                    </div>
                </div>
                <div className="cg-inner">
                    {[...WEAR_PRESETS, ''].map(value => (
                        <button
                            type="button"
                            key={value || 'until'}
                            className={patchWearDays === value ? 'on' : ''}
                            onClick={() => setPatchWearDays(value)}
                        >
                            {value ? `${value} ${t('unit.day_short')}` : t('m3e.field.patch_until')}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default PatchFields;
