import React from 'react';

interface IntroCardProps {
    /** The picture, mock or drawing the card exists to show. */
    visual: React.ReactNode;
    /**
     * Big type. Optional because the AI-assistant settings page shows the card as a
     * figure under a section label it already carries, so a second heading there
     * would be two titles for one section.
     */
    title?: string;
    description?: React.ReactNode;
    /**
     * Whether the visual sits inside the frame.
     *
     * A screen, a date field and the install mark are framed: the frame is what says
     * "this is a picture of a control", and it gives the mock the surface its own
     * roles were designed against. A photograph or the flag is not — there the
     * picture *is* the subject, and a rounded panel with its own background and
     * padding only competes with it. Unframed, the visual runs the full width of the
     * step so nothing sits between it and the reader.
     */
    framed?: boolean;
    /**
     * The step's surface is already the card's — see `journal`/`recheck` in
     * STEP_ROLES — so the visual sits straight on it. Unlike unframed, it keeps
     * the reading gutter: these visuals are cards of their own (the journal, the
     * reminder), not a photograph that should touch both edges.
     */
    bare?: boolean;
}

/**
 * The one layout every visual step in the flow shares — the start-date question,
 * the template/quick-record step, the signed-in account preview, the install step,
 * the assistant step and the send-off.
 *
 * A large rounded rectangle frames the visual, and the heading and its explanation
 * sit under it in the block's own ink and the same display type the text-only steps
 * use. That is what keeps a step that carries a picture reading as the same flow as
 * the ones that do not: the frame changes, the voice does not.
 *
 * The framed variant is an outlined M3 card at the extra-large corner — the same
 * recipe as `.m3-card-outlined`, one shape step up, because this holds a picture
 * rather than a paragraph. Its ground is the lowest surface role, so a mock of a
 * screen and a photograph sit on the same surface their own insides were designed
 * against.
 *
 * The heading and explanation are children of the step's block, not of the frame, so
 * `.intro-title` and `.intro-muted` resolve against the block the step is painted on.
 */
const IntroCard: React.FC<IntroCardProps> = ({ visual, title, description, framed = true, bare = false }) => (
    <div className="pt-8">
        {framed && !bare ? (
            <div className="overflow-hidden rounded-[var(--md-sys-shape-corner-extra-large)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-lowest)]">
                <div className="flex items-center justify-center p-4 sm:p-6">{visual}</div>
            </div>
        ) : (
            /* Unframed breaks out of the step's own 24px gutter so the picture
               touches both edges of the reading column; the words below stay
               where they were. A bare card keeps the gutter — see `bare`. */
            <div className={`${bare ? '' : '-mx-6 '}flex items-center justify-center`}>{visual}</div>
        )}
        {title && <h1 className="intro-title mt-6 text-m3-display-large break-words">{title}</h1>}
        {description && <p className="mt-3 text-m3-body-large intro-muted">{description}</p>}
    </div>
);

export default IntroCard;
