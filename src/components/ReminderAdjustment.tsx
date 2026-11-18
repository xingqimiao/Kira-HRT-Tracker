import { useState } from 'react';
import Switch from './Switch';
import { TimePage } from './TimePage';
import { Icon } from '../ui/SvgDefs';
import { adjustPlanReminder, readMedPlanState, writeMedPlans, type MedPlan } from '../utils/medPlan';
import { addCalendarDays, calendarDateIn, deviceTimeContext, parseCalendarDate, wallClockIn, zonedTimeToEpoch } from '../utils/timezone';
import { syncTimestamp } from '../utils/syncClock';

export function ReminderAdjustment({ plan, nextDueUtcMs, t, onCommit, variant = 'action', nextDueLabel }: {
    plan: MedPlan;
    nextDueUtcMs: number | null;
    t: (key: string) => string;
    onCommit?: (plan: MedPlan) => void;
    variant?: 'action' | 'row';
    nextDueLabel?: string;
}) {
    const [open, setOpen] = useState(false);
    const [base, setBase] = useState<number | null>(null);
    const [reanchor, setReanchor] = useState(false);
    const [invalid, setInvalid] = useState(false);
    const commit = (target: number | null) => {
        const state = readMedPlanState();
        const current = state.plans.find(item => item.id === plan.id);
        if (!current) return;
        try {
            const at = Math.max(syncTimestamp(), state.updatedAt + 1);
            const updated = adjustPlanReminder(current, deviceTimeContext(), target, reanchor, at);
            writeMedPlans(state.plans.map(item => item.id === current.id ? updated : item), at);
            if (target !== null && reanchor) onCommit?.(updated);
            setOpen(false);
        } catch {
            setInvalid(true);
        }
    };
    const addDay = (from: number) => {
        const { deviceTimezone: zone } = deviceTimeContext();
        const date = parseCalendarDate(addCalendarDays(calendarDateIn(zone, from), 1))!;
        const { hour, minute } = wallClockIn(zone, from);
        return zonedTimeToEpoch(zone, ...date, hour, minute);
    };
    const adjusted = plan.nextOverrideUtcMs != null;
    const detail = [adjusted ? t('plan.adjusted') : null, nextDueLabel].filter(Boolean).join(' · ');
    return <>
        <button type="button" className={variant === 'row' ? 'li tap text-left' : 'btn t'} aria-haspopup="dialog" aria-expanded={open} onClick={() => {
            setBase(nextDueUtcMs ?? Date.now());
            setReanchor(false);
            setInvalid(false);
            setOpen(true);
        }}>
            {variant === 'row' ? (
                <>
                    <span className="ic" aria-hidden="true"><Icon id="cal" /></span>
                    <span className="tx">
                        <span className="t">{t('plan.adjust_next')}</span>
                        {detail && <span className="s">{detail}</span>}
                    </span>
                    <Icon id="chev" />
                </>
            ) : t(adjusted ? 'plan.adjusted' : 'plan.adjust_next')}
        </button>
        {base !== null && <TimePage
            open={open}
            initialDate={new Date(base)}
            title={t('plan.adjust_next')}
            showRestoreNow={false}
            onClose={() => setOpen(false)}
            onConfirm={date => commit(date.getTime())}
            renderClockActions={selectDate => {
                const select = (target: number) => {
                    selectDate(new Date(target));
                    setInvalid(false);
                };
                return <div className="tp-reminder-actions">
                    <div className="tp-reminder-shortcuts">
                        {[-2, -1, 1, 2].map(hours => (
                            <button className="tpl-chip" type="button" key={hours} onClick={() => select(base + hours * 3_600_000)}>
                                {hours > 0 ? '+' : '−'}{Math.abs(hours)}h
                            </button>
                        ))}
                        <button type="button" className="tpl-chip" onClick={() => select(addDay(base))}>{t('plan.adjust_day')}</button>
                    </div>
                    {plan.mode !== 'times' && <div className="tp-reminder-cycle">
                        <span>{t('plan.reanchor')}</span>
                        <Switch checked={reanchor} onChange={() => setReanchor(!reanchor)} label={t('plan.reanchor')} />
                    </div>}
                    {plan.nextOverrideUtcMs != null && (
                        <button type="button" className="tpl-chip" onClick={() => commit(null)}>{t('plan.adjust_restore')}</button>
                    )}
                    {invalid && <p role="alert">{t('plan.adjust_invalid')}</p>}
                </div>;
            }}
        />}
    </>;
}
