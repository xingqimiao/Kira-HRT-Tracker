import React from 'react';
import Icon from '../components/Icon';
import { ExternalLink } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { HeaderBack } from '../ui/proto';
import { Icon as SpriteIcon } from '../ui/SvgDefs';
import { openExternalUrl } from '../utils/externalLinks';

interface LicenceSettingsProps {
    onBack: () => void;
    appVersion: string;
}

/**
 * The open-source licence notice.
 *
 * Two distinct things are acknowledged here, and the difference matters:
 *
 *   1. **The upstream works this app is built from or advises with** — the
 *      pharmacokinetic model design, the web app it was forked from, and
 *      Featherline's parameter advice (no code from either is copied).
 *   2. **The runtime dependencies.** Generated from `package.json`, never typed.
 *
 * ── The honest part ──────────────────────────────────────────────────────────
 *
 * The original algorithm repository declares no licence of its own, and no code
 * from it ships: the pharmacokinetic kernels were reimplemented from the
 * compartment ODEs, so that entry is a design credit rather than a permission.
 * `licence.no_licence_note` remains for the unlicensed upstream fork, which the
 * app does still descend from. See `THIRD-PARTY-LICENSES.md` before deploying
 * publicly.
 */
import { UPSTREAM_WORKS, RUNTIME_LICENCES, GENERATED_AT } from '../licences.generated';

const LicenceSettings: React.FC<LicenceSettingsProps> = ({ onBack, appVersion }) => {
    const { t } = useTranslation();

    return (
        <>
            <div className="pg on long licence-page">
                {/* The header is an opaque strip, not a translucent one. A transparent
                    sticky header let the rows show through the status-bar band while
                    scrolling, which read as a rendering leak. */}
                <div className="lic-head">
                    <HeaderBack
                        title={t('licence.title')}
                        onBack={onBack}
                        backLabel={t('core.back')}
                    />
                </div>

                <div className="d-col" style={{ gap: 12 }}>
                    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span className="ic p" style={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--pric)', color: 'var(--onpric)' }}>
                            <SpriteIcon id="code" />
                        </span>
                        {/* `center`, not `flex-start`: the badge is a 42dp disc and
                            the sentence is one or two lines, so top-aligning it left
                            the disc's centre below the first line's — the text and
                            the icon read as two different rows. */}
                        <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>{t('licence.intro')}</p>
                    </div>

                    <div className="lab" style={{ marginTop: 4 }}>{t('licence.upstream_title')}</div>
                    <div className="list">
                        {UPSTREAM_WORKS.map(work => (
                            <div
                                key={work.name}
                                className="li"
                                style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, padding: '14px 16px', cursor: 'default' }}
                            >
                                <div className="hrow" style={{ alignItems: 'flex-start', gap: 12 }}>
                                    <b style={{ fontSize: 15.5, lineHeight: 1.3 }}>{work.name}</b>
                                    <span className="chip" style={{ flex: 'none', background: 'var(--secc)', color: 'var(--onsecc)' }}>
                                        {work.licence}
                                    </span>
                                </div>
                                <p className="sub" style={{ margin: 0, lineHeight: 1.55 }}>{t(work.roleKey)}</p>
                                {work.noLicence && (
                                    <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--warn)' }}>
                                        {t('licence.no_licence_note')}
                                    </p>
                                )}
                                {work.referenceOnly && (
                                    <p className="sub" style={{ margin: 0, fontSize: 12.5 }}>{t('licence.reference_note')}</p>
                                )}
                                {work.copyright && (
                                    <p className="sub" style={{ margin: 0, fontSize: 11.5 }}>{work.copyright}</p>
                                )}
                                {work.url && (
                                    <button
                                        type="button"
                                        onClick={() => void openExternalUrl(work.url as string)}
                                        className="lic-link"
                                    >
                                        <Icon icon={ExternalLink} size={13} />
                                        {work.url.replace(/^https:\/\//, '')}
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>

                    <div className="lab" style={{ marginTop: 4 }}>{t('licence.deps_title')}</div>
                    <p className="sub" style={{ margin: '0 6px' }}>
                        {t('licence.deps_desc').replace('{n}', String(RUNTIME_LICENCES.length))}
                    </p>
                    <div className="list">
                        {RUNTIME_LICENCES.map(dep => (
                            <div key={dep.name} className="li" style={{ minHeight: 50, cursor: 'default' }}>
                                <div className="t"><b style={{ fontSize: 14, fontWeight: 600 }}>{dep.name}</b></div>
                                <span className="r" style={{ fontSize: 12 }}>{dep.licence}</span>
                            </div>
                        ))}
                    </div>

                    <div className="lab" style={{ marginTop: 4 }}>{t('licence.this_app_title')}</div>
                    <div className="list">
                        <div className="li" style={{ display: 'block', padding: 16, cursor: 'default' }}>
                            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>{t('licence.this_app_body')}</p>
                            <p className="sub" style={{ margin: '8px 0 0', fontSize: 11.5 }}>{t('licence.this_app_copyright')}</p>
                        </div>
                    </div>

                    <p className="sub" style={{ margin: '4px 6px 0', lineHeight: 1.7 }}>
                        {t('licence.generated').replace('{version}', appVersion).replace('{date}', GENERATED_AT)}
                    </p>
                </div>
            </div>
        </>
    );
};

export default LicenceSettings;
