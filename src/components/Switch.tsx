import React from 'react';

interface SwitchProps {
    /** The switch's state. Also its accessible state — see the note below. */
    checked: boolean;
    /** Called with the *next* value, so the caller does not have to negate. */
    onChange: (next: boolean) => void;
    disabled?: boolean;
    /**
     * The accessible name, for a switch with no visible text of its own. Callers
     * that put a visible label in the row should leave this out and let that text
     * name it, rather than reading the label twice.
     */
    label?: string;
    /** The element id, so a visible <label htmlFor> can point at the switch. */
    id?: string;
}

/**
 * The MD3 switch.
 *
 * Extracted because Settings had two of these written out inline, byte-identical
 * apart from the state variable — which is how the pair drifted from the spec
 * together and how the next toggle would have been a third copy rather than a
 * third call site.
 *
 * State is expressed as `aria-checked` and the styling is driven from that same
 * attribute in CSS (`.m3-switch[aria-checked="true"]`). One source of truth: the
 * thing a screen reader announces and the thing the eye sees are literally the
 * same attribute, so they cannot disagree. The previous inline version set a
 * class *and* the attribute from the same boolean but kept the visuals on the
 * class, which is how a switch ends up looking off while announcing "on".
 *
 * The wrapper stays a `<button>`: it is already focusable, keyboard-operable via
 * Space/Enter, and `role="switch"` is what makes the checked state meaningful to
 * assistive tech. A `<div>` with a click handler would need all three rebuilt.
 */
const Switch: React.FC<SwitchProps> = ({ checked, onChange, disabled, label, id }) => (
    <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="m3-switch"
    >
        <span className="m3-switch__thumb" />
    </button>
);

export default Switch;
