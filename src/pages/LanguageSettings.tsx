import React from 'react';
import { Check } from '../icons';
import Icon from '../components/Icon';
import { useTranslation } from '../contexts/LanguageContext';
import type { Lang } from '../i18n/types';
import { HeaderBack, SegmentedList, SegmentedListItem } from '../ui/proto';

interface LanguageSettingsProps {
    lang: Lang;
    setLang: (lang: Lang) => void;
    languageOptions: { value: Lang; label: string }[];
    onBack: () => void;
}

const LanguageSettings: React.FC<LanguageSettingsProps> = ({ lang, setLang, languageOptions, onBack }) => {
    const { t } = useTranslation();

    return (
        <div className="pg on long" style={{ maxWidth: 720, marginInline: 'auto', width: '100%' }}>
            <HeaderBack title={t('drawer.lang')} onBack={onBack} backLabel={t('core.back')} />
            <SegmentedList label={t('drawer.lang')}>
                {languageOptions.map(({ value, label }) => {
                    const active = lang === value;
                    return (
                        <SegmentedListItem
                            key={value}
                            title={label}
                            active={active}
                            leadingTone={active ? 'primary' : 'default'}
                            trailing={active ? <Icon icon={Check} size={20} /> : undefined}
                            aria-pressed={active}
                            onClick={() => setLang(value as Lang)}
                        />
                    );
                })}
            </SegmentedList>
        </div>
    );
};

export default LanguageSettings;
