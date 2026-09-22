import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { createPortal } from 'react-dom';
import { CalendarDays, Clock3, ChevronDown, Check } from '../icons';
import { useTranslation } from '../contexts/LanguageContext';
import { useEscape } from '../hooks/useEscape';
import { LOCALE_MAP } from '../utils/helpers';

interface DateTimePickerProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (date: Date) => void;
    initialDate?: Date;
    mode?: 'datetime' | 'date' | 'time';
    title?: string;
    inline?: boolean;
}

type DatePart = 'year' | 'month' | 'day' | 'hour' | 'minute';

interface PartOption {
    value: number;
    label: string;
}

interface PartSelectProps {
    label: string;
    value: number;
    options: PartOption[];
    onChange: (value: number) => void;
}

const PartSelect: React.FC<PartSelectProps> = ({ label, value, options, onChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    const [positionStyle, setPositionStyle] = useState<React.CSSProperties>({});

    useEffect(() => {
        if (typeof document !== 'undefined') setPortalTarget(document.body);
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (
                (triggerRef.current && triggerRef.current.contains(event.target as Node)) ||
                (listRef.current && listRef.current.contains(event.target as Node))
            ) return;
            setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    useLayoutEffect(() => {
        if (!isOpen || !triggerRef.current) return;

        const updatePosition = () => {
            const rect = triggerRef.current!.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;
            const flip = spaceBelow < 160 && spaceAbove > spaceBelow;
            const maxHeight = Math.max(120, Math.min(240, (flip ? spaceAbove : spaceBelow) - 16));
            const width = Math.max(rect.width, 72);

            if (flip) {
                setPositionStyle({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width, maxHeight });
            } else {
                setPositionStyle({ top: rect.bottom + 4, left: rect.left, width, maxHeight });
            }
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, { capture: true, passive: true });
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, { capture: true });
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const el = listRef.current?.querySelector('[data-selected="true"]') as HTMLElement | null;
        el?.scrollIntoView({ block: 'center' });
    }, [isOpen]);

    const selected = options.find(option => option.value === value);

    return (
        <div className="relative">
            <button
                type="button"
                ref={triggerRef}
                onClick={() => setIsOpen(open => !open)}
                aria-label={label}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                className={`w-full min-h-11 flex items-center justify-between gap-1 rounded-lg border px-2.5 py-2 text-sm tabular-nums outline-none transition-colors motion-reduce:transition-none
                    bg-cos-surface-container  text-[var(--color-m3-on-surface)] 
                    ${isOpen
                        ? 'border-[var(--color-m3-primary)] ring-1 ring-[var(--color-m3-primary)]/20'
                        : 'border-[var(--color-m3-outline-variant)]  hover:border-[var(--color-m3-outline)] '}`}
            >
                <span className="truncate">{selected?.label ?? value}</span>
                <Icon icon={ChevronDown}
                    size={14}
                    className={`chev shrink-0 text-[var(--color-m3-on-surface-variant)]  ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && portalTarget && createPortal(
                <div
                    ref={listRef}
                    role="listbox"
                    aria-label={label}
                    style={positionStyle}
                    className="dropdown-in fixed z-[80] overflow-y-auto scrollbar-hide rounded-lg border border-[var(--color-m3-outline-variant)]  bg-cos-surface-container  shadow-[var(--shadow-m3-3)] py-1"
                >
                    {options.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={option.value === value}
                            data-selected={option.value === value}
                            onClick={() => { onChange(option.value); setIsOpen(false); }}
                            className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-start tabular-nums
                                ${option.value === value
                                    ? 'bg-[var(--color-m3-primary-container)]  text-[var(--color-m3-on-primary-container)]  font-medium'
                                    : 'text-[var(--color-m3-on-surface)]  hover:bg-[var(--color-m3-surface-container)] '}`}
                        >
                            <span>{option.label}</span>
                            {option.value === value && <Icon icon={Check} size={14} className="text-[var(--color-m3-primary)]" strokeWidth={2.5} />}
                        </button>
                    ))}
                </div>,
                portalTarget,
            )}
        </div>
    );
};

const DateTimePicker: React.FC<DateTimePickerProps> = ({
    isOpen,
    onClose,
    onConfirm,
    initialDate,
    mode = 'datetime',
    title,
    inline = false,
}) => {
    const { t, lang } = useTranslation();
    useEscape(onClose, isOpen);
    const locale = LOCALE_MAP[lang] || 'en-US';

    const [selectedDate, setSelectedDate] = useState(initialDate || new Date());
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    const [positionStyle, setPositionStyle] = useState<React.CSSProperties>({});
    const containerRef = useRef<HTMLDivElement>(null);
    const anchorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (typeof document !== 'undefined') setPortalTarget(document.body);
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        const candidate = initialDate ? new Date(initialDate) : new Date();
        setSelectedDate(Number.isNaN(candidate.getTime()) ? new Date() : candidate);
    }, [isOpen, initialDate]);

    useLayoutEffect(() => {
        if (!isOpen || inline) return;

        const updatePosition = () => {
            if (window.innerWidth < 768) {
                setPositionStyle({});
                return;
            }
            setPositionStyle({
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 440,
            });
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        return () => window.removeEventListener('resize', updatePosition);
    }, [isOpen, inline]);

    const currentYear = new Date().getFullYear();
    const years = useMemo(() => {
        // History only: years run from 2000 up to *this* year, recomputed on every
        // render so the ceiling advances on its own each January. A date already
        // stored outside that window (an import, or a share expiring into next year)
        // still has to be representable, or the picker would list a year it cannot
        // show — so the window stretches to include the current selection.
        const selectedYear = selectedDate.getFullYear();
        const first = Math.min(2000, selectedYear);
        const last = Math.max(currentYear, selectedYear);
        return Array.from({ length: last - first + 1 }, (_, index) => first + index);
    }, [currentYear, selectedDate]);

    const months = useMemo(() => (
        Array.from({ length: 12 }, (_, month) => ({
            value: month,
            label: new Date(2020, month, 1).toLocaleDateString(locale, { month: 'long' }),
        }))
    ), [locale]);

    const daysInSelectedMonth = new Date(
        selectedDate.getFullYear(),
        selectedDate.getMonth() + 1,
        0,
    ).getDate();

    const days = Array.from({ length: daysInSelectedMonth }, (_, index) => index + 1);
    const hours = Array.from({ length: 24 }, (_, index) => index);
    const minutes = Array.from({ length: 60 }, (_, index) => index);

    const setPart = (part: DatePart, value: number) => {
        const next = new Date(selectedDate);

        if (part === 'year' || part === 'month') {
            const originalDay = next.getDate();
            next.setDate(1);
            if (part === 'year') next.setFullYear(value);
            else next.setMonth(value);
            const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
            next.setDate(Math.min(originalDay, maxDay));
        } else if (part === 'day') {
            next.setDate(value);
        } else if (part === 'hour') {
            next.setHours(value);
        } else {
            next.setMinutes(value);
        }

        next.setSeconds(0, 0);
        setSelectedDate(next);
        // Inline pickers live inside a form — apply changes immediately instead
        // of requiring a separate confirm step; closing stays under the caller's control.
        if (inline) onConfirm(next);
    };

    const labelClass = 'block mb-1.5 text-xs font-medium text-[var(--color-m3-on-surface-variant)] ';

    const renderPart = (
        label: string,
        part: DatePart,
        value: number,
        options: PartOption[],
    ) => (
        <div className="min-w-0">
            <span className={labelClass}>{label}</span>
            <PartSelect
                label={label}
                value={value}
                options={options}
                onChange={next => setPart(part, next)}
            />
        </div>
    );

    if (!isOpen) return inline ? null : <div ref={anchorRef} className="hidden" />;
    if (!inline && !portalTarget) return <div ref={anchorRef} className="hidden" />;

    const showDate = mode !== 'time';
    const showTime = mode !== 'date';
    const dateSummary = selectedDate.toLocaleDateString(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    const timeSummary = selectedDate.toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });

    const body = (
        <div className={inline ? 'pt-3 pb-1 space-y-5' : 'px-5 py-5 space-y-5'}>
            {showDate && (
                <section>
                    <div className="flex items-center gap-2 mb-3 text-[var(--color-m3-on-surface)] ">
                        <Icon icon={CalendarDays} size={16} />
                        <span className="text-sm font-medium">{t('date.select')}</span>
                    </div>
                    <div className="grid grid-cols-[1.05fr_1.35fr_0.8fr] gap-2.5">
                        {renderPart(
                            t('time.year'),
                            'year',
                            selectedDate.getFullYear(),
                            years.map(year => ({ value: year, label: String(year) })),
                        )}
                        {renderPart(t('time.month'), 'month', selectedDate.getMonth(), months)}
                        {renderPart(
                            t('time.day'),
                            'day',
                            selectedDate.getDate(),
                            days.map(day => ({ value: day, label: String(day).padStart(2, '0') })),
                        )}
                    </div>
                </section>
            )}

            {showTime && (
                <section>
                    <div className="flex items-center gap-2 mb-3 text-[var(--color-m3-on-surface)] ">
                        <Icon icon={Clock3} size={16} />
                        <span className="text-sm font-medium">{t('time.select')}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                        {renderPart(
                            t('time.hour'),
                            'hour',
                            selectedDate.getHours(),
                            hours.map(hour => ({ value: hour, label: String(hour).padStart(2, '0') })),
                        )}
                        {renderPart(
                            t('time.minute'),
                            'minute',
                            selectedDate.getMinutes(),
                            minutes.map(minute => ({ value: minute, label: String(minute).padStart(2, '0') })),
                        )}
                    </div>
                </section>
            )}
        </div>
    );

    if (inline) return <div className="mb-3">{body}</div>;

    const inner = (
        <div className="rounded-xl border border-[var(--color-m3-outline-variant)]  bg-[var(--color-m3-surface-container-lowest)] ">
            <div className="px-5 pt-5 pb-4 border-b border-[var(--color-m3-outline-variant)] ">
                {title && (
                    <p className="text-sm font-semibold text-[var(--color-m3-on-surface)]  mb-1">
                        {title}
                    </p>
                )}
                <p className="text-sm tabular-nums text-[var(--color-m3-on-surface-variant)] ">
                    {[showDate ? dateSummary : null, showTime ? timeSummary : null].filter(Boolean).join(' · ')}
                </p>
            </div>

            {body}

            <div className="px-5 pb-5 pt-3 flex justify-end gap-2 border-t border-[var(--color-m3-outline-variant)] ">
                <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2.5 text-sm font-medium rounded-md text-[var(--color-m3-on-surface-variant)]  hover:bg-[var(--color-m3-surface-container)] "
                >
                    {t('btn.cancel')}
                </button>
                <button
                    type="button"
                    onClick={() => onConfirm(selectedDate)}
                    className="px-5 py-2.5 text-sm font-medium rounded-md bg-[var(--color-m3-primary)] hover:bg-[var(--color-m3-primary-light)] text-cos-on-primary"
                >
                    {t('btn.ok')}
                </button>
            </div>
        </div>
    );

    return (
        <>
            <div ref={anchorRef} className="hidden" />
            {createPortal(
                <>
                    <button
                        type="button"
                        aria-label={t('btn.cancel')}
                        onClick={onClose}
                        className="fixed inset-0 z-[60] bg-black/30 "
                    />
                    <div
                        ref={containerRef}
                        style={positionStyle}
                        className={`fixed z-[70] bg-[var(--color-m3-surface-container-lowest)]  overflow-hidden shadow-[var(--shadow-m3-3)] border border-[var(--color-m3-outline-variant)]  ${Object.keys(positionStyle).length > 0 ? 'rounded-[var(--radius-xl)]' : 'bottom-0 left-0 right-0 w-full rounded-t-[var(--radius-xl)] border-b-0'}`}
                    >
                        {inner}
                    </div>
                </>,
                portalTarget!,
            )}
        </>
    );
};

export default DateTimePicker;
