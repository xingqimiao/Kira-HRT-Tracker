import React from 'react';
import Icon from '../components/Icon';
import { Heart } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { HeaderBack } from '../ui/proto';
import { useSupporters } from '../hooks/useSupporters';

/**
 * The full thank-you list.
 *
 * A page rather than a sheet: the list is the reason someone tapped, and a sheet
 * would cap it at 88% of the screen for no reason. The server caps the list at 200
 * rows, which a plain `.list` renders comfortably; virtualization is only worth
 * its complexity above that.
 */
const SupportersList: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const { t } = useTranslation();
    const { supporters, loaded } = useSupporters();

    return (
        <div className="pg on long supporters-page">
            <div className="lic-head">
                <HeaderBack title={t('donate.supporters_title')} onBack={onBack} backLabel={t('core.back')} />
            </div>

            <div className="d-col" style={{ gap: 12 }}>
                {!loaded ? (
                    <p className="sub" style={{ margin: '8px 6px', textAlign: 'center' }}>{t('donate.supporters_loading')}</p>
                ) : supporters.length === 0 ? (
                    <div className="card">
                        <p className="sub" style={{ margin: 0, textAlign: 'center' }}>{t('donate.supporters_empty')}</p>
                    </div>
                ) : (
                    <div className="list">
                        {supporters.map(supporter => (
                            <div key={supporter.id} className="li" style={{ cursor: 'default' }}>
                                <span className="ic p">
                                    <Icon icon={Heart} size={22} />
                                </span>
                                <span className="t">
                                    <b>{supporter.name}</b>
                                    <span className="s">
                                        {supporter.source === 'bmc'
                                            ? t('donate.source_bmc')
                                            : supporter.source === 'afdian'
                                                ? t('donate.source_afdian')
                                                : t('donate.source_crypto')}
                                    </span>
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default SupportersList;
