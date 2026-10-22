import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/SvgDefs';
import { useTranslation } from '../contexts/LanguageContext';
import { LOCALE_MAP } from '../utils/helpers';
import { useBackHandler } from '../utils/nativeBack';

/**
 * The M3E calendar + clock page, extracted from the dose panel's `#timePage`.
 *
 * The lab editor used to unfold an inline three-dropdown picker; this is the
 * newer secondary page: a month grid, a 24-hour stepper, and one confirm bar.
 * It covers the viewport above a bottom sheet because it is a drill-in page, not
 * a popover.
 */

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export interface TimePageProps {
    open: boolean;
    initialDate: Date;
    onClose: () => void;
    onConfirm: (date: Date) => void;
    /** Which halves of the page to show. Default is both. */
    mode?: 'datetime' | 'date' | 'time';
    title?: string;
}

export function TimePage({ open, initialDate, onClose, onConfirm, mode = 'datetime', title }: TimePageProps) {
    const { t, lang } = useTranslation();
    const locale = LOCALE_MAP[lang] || 'en-US';
    const [draft, setDraft] = useState(initialDate);
    const [year, setYear] = useState(initialDate.getFullYear());
    const [month, setMonth] = useState(initialDate.getMonth() + 1);
    const [yearText, setYearText] = useState(() => String(initialDate.getFullYear()));
    const [monthText, setMonthText] = useState(() => String(initialDate.getMonth() + 1).padStart(2, '0'));
    const [dayText, setDayText] = useState(() => String(initialDate.getDate()).padStart(2, '0'));
    const [hourText, setHourText] = useState(() => String(initialDate.getHours()).padStart(2, '0'));
    const [minuteText, setMinuteText] = useState(() => String(initialDate.getMinutes()).padStart(2, '0'));
    const [monthMotion, setMonthMotion] = useState<'next' | 'prev'>('next');
    const [clockPulse, setClockPulse] = useState(0);
    const showDate = mode !== 'time';
    const showTime = mode !== 'date';

    useBackHandler(open, () => {
        onClose();
        return true;
    });

    useEffect(() => {
        if (!open) return;
        const next = Number.isNaN(initialDate.getTime()) ? new Date() : initialDate;
        setDraft(next);
        setYear(next.getFullYear());
        setMonth(next.getMonth() + 1);
        setYearText(String(next.getFullYear()));
        setMonthText(String(next.getMonth() + 1).padStart(2, '0'));
        setDayText(String(next.getDate()).padStart(2, '0'));
        setHourText(String(next.getHours()).padStart(2, '0'));
        setMinuteText(String(next.getMinutes()).padStart(2, '0'));
    }, [open, initialDate]);

    /** One writer for the draft, the calendar view and every editable field. */
    const applyDraft = (next: Date) => {
        setDraft(next);
        setYear(next.getFullYear());
        setMonth(next.getMonth() + 1);
        setYearText(String(next.getFullYear()));
        setMonthText(String(next.getMonth() + 1).padStart(2, '0'));
        setDayText(String(next.getDate()).padStart(2, '0'));
        setHourText(String(next.getHours()).padStart(2, '0'));
        setMinuteText(String(next.getMinutes()).padStart(2, '0'));
    };

    const weekdays = useMemo(() => {
        if (lang === 'zh' || lang === 'zh-TW' || lang === 'yue') return WEEKDAYS_ZH;
        try {
            const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
            const sunday = new Date(2024, 0, 7);
            return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(sunday.getTime() + i * 86_400_000)));
        } catch {
            return ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        }
    }, [lang, locale]);

    const cells = useMemo(() => {
        const firstWeekday = new Date(year, month - 1, 1).getDay();
        const daysInMonth = new Date(year, month, 0).getDate();
        const out: Array<{ day: number | null; key: string }> = [];
        for (let i = 0; i < firstWeekday; i += 1) out.push({ day: null, key: `e${i}` });
        for (let day = 1; day <= daysInMonth; day += 1) out.push({ day, key: `d${day}` });
        while (out.length % 7 !== 0) out.push({ day: null, key: `t${out.length}` });
        return out;
    }, [year, month]);

    const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

    const changeMonth = (delta: number) => {
        setMonthMotion(delta > 0 ? 'next' : 'prev');
        const next = new Date(year, month - 1 + delta, 1);
        const nextYear = next.getFullYear();
        const nextMonth = next.getMonth() + 1;
        const day = Math.min(Number(dayText) || draft.getDate(), daysIn(nextYear, nextMonth));
        applyDraft(new Date(nextYear, nextMonth - 1, day, draft.getHours(), draft.getMinutes()));
    };

    const pickDay = (day: number) => {
        applyDraft(new Date(year, month - 1, day, draft.getHours(), draft.getMinutes()));
    };

    const step = (kind: 'h' | 'm', delta: number) => {
        const next = new Date(draft);
        if (kind === 'h') next.setHours((next.getHours() + delta + 24) % 24);
        else next.setMinutes((next.getMinutes() + delta + 60) % 60);
        applyDraft(next);
    };

    const restoreNow = () => {
        const now = new Date();
        applyDraft(now);
        onConfirm(now);
    };

    /**
     * Date parts are editable too. As with the clock, the raw text is kept while
     * typing and normalised on blur; an out-of-range number does not move the
     * draft, so the calendar never jumps to an invalid month while half-typed.
     */
    const typeDatePart = (kind: 'y' | 'm' | 'd', raw: string) => {
        const digits = raw.replace(/\D/g, '').slice(0, kind === 'y' ? 4 : 2);
        if (kind === 'y') setYearText(digits);
        else if (kind === 'm') setMonthText(digits);
        else setDayText(digits);

        const y = kind === 'y' ? Number(digits) : Number(yearText);
        const m = kind === 'm' ? Number(digits) : Number(monthText);
        const d = kind === 'd' ? Number(digits) : Number(dayText);
        if (kind === 'y' && digits.length < 4) return;
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return;
        if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return;
        const next = new Date(y, m - 1, d, draft.getHours(), draft.getMinutes());
        setDraft(next);
        setYear(y);
        setMonth(m);
    };

    const commitDatePart = (kind: 'y' | 'm' | 'd') => {
        const raw = kind === 'y' ? yearText : kind === 'm' ? monthText : dayText;
        const parsed = Number.parseInt(raw, 10);
        let y = Number(yearText);
        let m = Number(monthText);
        let d = Number(dayText);
        if (kind === 'y') y = Number.isFinite(parsed) && parsed >= 1900 && parsed <= 2100 ? parsed : draft.getFullYear();
        if (kind === 'm') m = Number.isFinite(parsed) && parsed >= 1 && parsed <= 12 ? parsed : draft.getMonth() + 1;
        if (kind === 'd') d = Number.isFinite(parsed) ? parsed : draft.getDate();
        if (!Number.isFinite(y) || y < 1900 || y > 2100) y = draft.getFullYear();
        if (!Number.isFinite(m) || m < 1 || m > 12) m = draft.getMonth() + 1;
        const maxDay = daysIn(y, m);
        d = Math.min(maxDay, Math.max(1, Number.isFinite(d) ? d : draft.getDate()));
        applyDraft(new Date(y, m - 1, d, draft.getHours(), draft.getMinutes()));
    };

    /**
     * Typing a part updates the draft as soon as the number is in range, but
     * leaves the raw text alone until blur. Normalising on every keystroke
     * fights the caret: typing "2" then "3" would rewrite the box to "02".
     */
    const typePart = (kind: 'h' | 'm', raw: string) => {
        const digits = raw.replace(/\D/g, '').slice(0, 2);
        if (kind === 'h') setHourText(digits);
        else setMinuteText(digits);
        if (digits === '') return;
        const n = Number(digits);
        const max = kind === 'h' ? 23 : 59;
        if (!Number.isFinite(n) || n > max) return;
        const next = new Date(draft);
        if (kind === 'h') next.setHours(n);
        else next.setMinutes(n);
        setDraft(next);
    };

    const commitPart = (kind: 'h' | 'm') => {
        const raw = kind === 'h' ? hourText : minuteText;
        const max = kind === 'h' ? 23 : 59;
        const n = Math.min(max, Math.max(0, Number.parseInt(raw, 10) || 0));
        const next = new Date(draft);
        if (kind === 'h') next.setHours(n);
        else next.setMinutes(n);
        applyDraft(next);
    };

    const nudgePart = (kind: 'h' | 'm', delta: number) => {
        setClockPulse(k => k + 1);
        step(kind, delta);
    };

    return createPortal(
        <div className={`dose-panel lab-time${open ? ' open' : ''}`} aria-hidden={!open || undefined}>
            <div className="sub-page open">
                <div className="hdr">
                    <div className="hdr-l">
                        <button type="button" className="ic-btn" data-m style={{ ['--mo' as string]: '12px' }} onClick={onClose} aria-label={t('btn.cancel')}>
                            <Icon id="chev" style={{ transform: 'rotate(180deg)' }} />
                        </button>
                        <span className="hdr-title">{title ?? t('m3e.time.title')}</span>
                    </div>
                    <button type="button" className="tpl-chip on" data-m style={{ ['--mo' as string]: '10px' }} onClick={restoreNow}>
                        {t('m3e.time.now_restore')}
                    </button>
                </div>

                <div className={`tp-layout${!showDate || !showTime ? ' single' : ''}`}>
                    {showDate && (
                    <div className="m3e-cal-card">
                        <div className="cal-head">
                            <button type="button" className="cal-nav-btn" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => changeMonth(-1)} aria-label="prev">
                                <Icon id="chev" style={{ transform: 'rotate(180deg)' }} />
                            </button>
                            <span className="cal-title">{t('date.select')}</span>
                            <button type="button" className="cal-nav-btn" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => changeMonth(1)} aria-label="next">
                                <Icon id="chev" />
                            </button>
                        </div>
                        <div className="tp-date-row">
                            <label className="tp-date-part">
                                <span>{t('time.year')}</span>
                                <input
                                    className="tp-date-input"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={4}
                                    value={yearText}
                                    onChange={(e) => typeDatePart('y', e.target.value)}
                                    onBlur={() => commitDatePart('y')}
                                    onFocus={(e) => e.currentTarget.select()}
                                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                    aria-label={t('time.year')}
                                />
                            </label>
                            <label className="tp-date-part">
                                <span>{t('time.month')}</span>
                                <input
                                    className="tp-date-input"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={2}
                                    value={monthText}
                                    onChange={(e) => typeDatePart('m', e.target.value)}
                                    onBlur={() => commitDatePart('m')}
                                    onFocus={(e) => e.currentTarget.select()}
                                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                    aria-label={t('time.month')}
                                />
                            </label>
                            <label className="tp-date-part">
                                <span>{t('time.day')}</span>
                                <input
                                    className="tp-date-input"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={2}
                                    value={dayText}
                                    onChange={(e) => typeDatePart('d', e.target.value)}
                                    onBlur={() => commitDatePart('d')}
                                    onFocus={(e) => e.currentTarget.select()}
                                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                    aria-label={t('time.day')}
                                />
                            </label>
                        </div>
                        <div className="cal-week">
                            {weekdays.map((label, idx) => <span key={`${label}-${idx}`}>{label}</span>)}
                        </div>
                        <div key={`${year}-${month}`} className={`cal-grid ${monthMotion}`}>
                            {cells.map(cell => cell.day === null ? (
                                <div className="cal-day empty" key={cell.key} />
                            ) : (
                                <button
                                    type="button"
                                    key={cell.key}
                                    className={`cal-day${sameDay(new Date(year, month - 1, cell.day), new Date()) ? ' today' : ''}${sameDay(new Date(year, month - 1, cell.day), draft) ? ' on' : ''}`}
                                    data-m
                                    style={{ ['--mo' as string]: '10px' }}
                                    onClick={() => pickDay(cell.day!)}
                                >
                                    {cell.day}
                                </button>
                            ))}
                        </div>
                    </div>
                    )}

                    {showTime && (
                    <div className="tp-card">
                        <div className="tp-caption">{t('m3e.time.clock')}</div>
                        <div className="tp-display" key={`clock-${clockPulse}`}>
                            <div className="tp-col">
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => nudgePart('h', 1)}>+</button>
                                <input
                                    className="tp-box tp-input"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={2}
                                    value={hourText}
                                    onChange={(e) => typePart('h', e.target.value)}
                                    onBlur={() => commitPart('h')}
                                    onFocus={(e) => e.currentTarget.select()}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') e.currentTarget.blur();
                                        if (e.key === 'ArrowUp') { e.preventDefault(); nudgePart('h', 1); }
                                        if (e.key === 'ArrowDown') { e.preventDefault(); nudgePart('h', -1); }
                                    }}
                                    aria-label={t('time.hour')}
                                />
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => nudgePart('h', -1)}>−</button>
                            </div>
                            <span className="tp-colon">:</span>
                            <div className="tp-col">
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => nudgePart('m', 1)}>+</button>
                                <input
                                    className="tp-box tp-input"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={2}
                                    value={minuteText}
                                    onChange={(e) => typePart('m', e.target.value)}
                                    onBlur={() => commitPart('m')}
                                    onFocus={(e) => e.currentTarget.select()}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') e.currentTarget.blur();
                                        if (e.key === 'ArrowUp') { e.preventDefault(); nudgePart('m', 1); }
                                        if (e.key === 'ArrowDown') { e.preventDefault(); nudgePart('m', -1); }
                                    }}
                                    aria-label={t('time.minute')}
                                />
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => nudgePart('m', -1)}>−</button>
                            </div>
                        </div>
                        <button
                            type="button"
                            className="save-btn tp-confirm"
                            data-m
                            style={{ ['--mo' as string]: '16px' }}
                            onClick={() => onConfirm(draft)}
                        >
                            <Icon id="check" />{t('m3e.time.confirm')}
                        </button>
                    </div>
                    )}

                    {!showTime && (
                        <button
                            type="button"
                            className="save-btn tp-confirm"
                            data-m
                            style={{ ['--mo' as string]: '16px', width: '100%', maxWidth: 420, margin: '12px auto 0' }}
                            onClick={() => onConfirm(draft)}
                        >
                            <Icon id="check" />{t('m3e.time.confirm')}
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
