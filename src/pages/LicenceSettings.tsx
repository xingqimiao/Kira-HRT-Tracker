import React from 'react';
import Icon from '../components/Icon';
import { ArrowLeft, CodeFile, ExternalLink } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';

interface LicenceSettingsProps {
    onBack: () => void;
    appVersion: string;
}

/**
 * The open-source licence notice.
 *
 * Two distinct things are acknowledged here, and the difference matters:
 *
 *   1. **The upstream works this app is built from** — the pharmacokinetic
 *      algorithm and the web app it was forked from. These are not dependencies in
 *      `package.json`; they are people's source code, vendored or reimplemented, and
 *      the algorithm is the substance of what this app does.
 *   2. **The runtime dependencies.** A list, because a licence notice that omits
 *      them is not a notice.
 *
 * ── The honest part ──────────────────────────────────────────────────────────
 *
 * The algorithm repository **declares no licence at all**. That is stated plainly
 * rather than glossed as "MIT" or left off the list: an attribution page that
 * implies a permission nobody granted is worse than one that admits the gap. The
 * wording is the same as `server/DEPLOY.md`, which is where the finding was first
 * recorded — see the licence section there before deploying publicly.
 *
 * The dependency list is generated from `package.json` at build time rather than
 * hand-written, because a hand-maintained list is wrong the first time somebody
 * adds a package. `scripts/gen-licences.mjs` writes the generated module; this
 * component only renders it.
 */
import { UPSTREAM_WORKS, RUNTIME_LICENCES, GENERATED_AT } from '../licences.generated';

const divider = 'border-b border-[var(--color-m3-outline-variant)] ';
const sectionLabel = 'text-xs font-semibold text-[var(--color-m3-on-surface-variant)] ';
const body = 'text-[0.9375rem] leading-relaxed text-[var(--color-m3-on-surface)] ';
const muted = 'text-[0.8125rem] leading-relaxed text-[var(--color-m3-on-surface-variant)] ';
const mono = 'font-mono text-xs text-[var(--color-m3-on-surface-variant)] ';

const LicenceSettings: React.FC<LicenceSettingsProps> = ({ onBack, appVersion }) => {
    const { t } = useTranslation();

    return (
        <div className="relative pb-32">
            <div className="sticky top-0 z-20 bg-[var(--color-m3-surface-dim)] px-6 md:px-8 pt-8 pb-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-3 -ml-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={ArrowLeft} size={18} className={`${muted} shrink-0`} />
                    <span className="text-xl font-semibold text-[var(--color-m3-on-surface)] ">
                        {t('licence.title')}
                    </span>
                </button>
            </div>

            <div className="mx-auto w-full px-6 md:px-8 mt-4 max-w-2xl">
                <div className="flex items-start gap-3 pb-4">
                    <div className="p-2 rounded-lg bg-[var(--color-m3-surface-container)] shrink-0">
                        <Icon icon={CodeFile} size={18} strokeWidth={1.75} className={muted} />
                    </div>
                    <p className={muted}>{t('licence.intro')}</p>
                </div>

                {/* 1. Upstream works. */}
                <section className={`py-4 ${divider}`}>
                    <p className={sectionLabel}>{t('licence.upstream_title')}</p>
                    <ul className="mt-3 space-y-4">
                        {UPSTREAM_WORKS.map((work) => (
                            <li key={work.name}>
                                <div className="flex items-start justify-between gap-3">
                                    <p className={`${body} font-medium`}>{work.name}</p>
                                    <span className={`${mono} shrink-0 pt-1`}>{work.licence}</span>
                                </div>
                                <p className={`mt-0.5 ${muted}`}>
                                    {t(work.roleKey)}
                                </p>
                                {work.noLicence && (
                                    <p className="mt-1.5 text-xs leading-relaxed text-cos-warning ">
                                        {t('licence.no_licence_note')}
                                    </p>
                                )}
                                {/* A grant is not a public licence: it exists because the
                                    copyright holder said yes, and it is narrower than one
                                    (non-commercial). Neither fact is visible from their
                                    repository, so both are stated here rather than left to
                                    the `licence` column, which can carry four words. */}
                                {work.granted && (
                                    <p className="mt-1.5 text-xs leading-relaxed text-cos-success">
                                        {t('licence.granted_note')}
                                    </p>
                                )}
                                {work.url && (
                                    <button
                                        onClick={() => window.open(work.url, '_blank', 'noopener')}
                                        className="mt-1 inline-flex items-center gap-1.5 text-xs text-[var(--color-m3-primary)] hover:underline"
                                    >
                                        <Icon icon={ExternalLink} size={12} />
                                        {work.url.replace(/^https:\/\//, '')}
                                    </button>
                                )}
                                {work.copyright && (
                                    <p className={`mt-1 ${mono} break-all`}>{work.copyright}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>

                {/* 2. Runtime dependencies. */}
                <section className={`py-4 ${divider}`}>
                    <p className={sectionLabel}>{t('licence.deps_title')}</p>
                    <p className={`mt-1 ${muted}`}>
                        {t('licence.deps_desc').replace('{n}', String(RUNTIME_LICENCES.length))}
                    </p>
                    <ul className="mt-3">
                        {RUNTIME_LICENCES.map((dep) => (
                            <li
                                key={dep.name}
                                className={`flex items-baseline justify-between gap-4 py-2 ${divider} last:border-b-0`}
                            >
                                <span className={`${body} truncate`} title={dep.name}>
                                    {dep.name}
                                </span>
                                <span className={`${mono} shrink-0`}>{dep.licence}</span>
                            </li>
                        ))}
                    </ul>
                </section>

                {/* 3. This app's own licence. */}
                <section className="py-4">
                    <p className={sectionLabel}>{t('licence.this_app_title')}</p>
                    <p className={`mt-1 ${body}`}>{t('licence.this_app_body')}</p>
                    <p className={`mt-2 ${mono} break-all`}>{t('licence.this_app_copyright')}</p>
                </section>

                <p className={`mt-6 ${muted}`}>
                    {t('licence.generated').replace('{version}', appVersion).replace('{date}', GENERATED_AT)}
                </p>
            </div>
        </div>
    );
};

export default LicenceSettings;
