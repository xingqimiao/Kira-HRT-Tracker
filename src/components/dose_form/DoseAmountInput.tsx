import React from 'react';

/**
 * A dose amount box: a bare, borderless number input sized to the row it sits in.
 *
 * Shared by every route's dose rows so they look identical; the row (a `FieldRow`)
 * supplies the icon and caption, and this supplies the value and the unit.
 */
export interface AmountField {
    key: string;
    label: string;
    value: string;
    onChange: (v: string) => void;
    /** A derived read-out shown under the box (e.g. an EV injection's E2 equivalent). */
    hint?: string;
    unit?: string;
}

const DoseAmountInput: React.FC<{ field: AmountField }> = ({ field }) => (
    <div>
        <div className="flex items-center gap-2">
            <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.001"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                placeholder="0.0"
                className="hrt-num"
                style={{ fontSize: '16px' }}
            />
            <span className="text-xs text-[var(--color-m3-on-surface-variant)] shrink-0">{field.unit ?? 'mg'}</span>
        </div>
        {field.hint && (
            <p className="text-xs text-[var(--color-m3-on-surface-variant)] mt-1">{field.hint}</p>
        )}
    </div>
);

export default DoseAmountInput;
