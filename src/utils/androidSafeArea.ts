type AndroidSafeArea = {
    top(): number;
    bottom(): number;
    /**
     * The soft keyboard's height in dp, 0 when closed.
     *
     * Optional in the type: an APK built before this bridge method existed has no
     * `ime()`, and the page must keep working rather than throwing on a missing
     * function.
     */
    ime?(): number;
};

declare global {
    interface Window { HrtSafeArea?: AndroidSafeArea }
}

/**
 * Publish the system-bar and keyboard insets to CSS.
 *
 * Three custom properties, all in px:
 *
 *   --android-safe-top     status bar / cutout
 *   --android-safe-bottom  navigation bar or gesture handle
 *   --android-ime-bottom   soft keyboard
 *
 * The bars are read once and on change. The keyboard is *animated*: Android 11+
 * reports its height frame by frame while it opens, and `hrt-ime-progress`
 * carries each of those frames (see the `WindowInsetsAnimationCompat` callback in
 * `scripts/MainActivity.kt`). Writing every frame to a custom property is what
 * lets the page follow the keyboard instead of snapping once it has finished —
 * `adjustResize` alone resizes the WebView before the first frame of the
 * animation, so the jump is already over by the time the page hears about it.
 *
 * The property is a *measurement*, not a layout instruction: `index.css` decides
 * what to do with it (today: keep a focused field above the keyboard). A page
 * that ignores it still gets the resize, which is the pre-existing behaviour.
 */
export function initAndroidSafeArea(): void {
    const root = document.documentElement;
    const setPx = (name: string, value: number) => {
        if (Number.isFinite(value) && value >= 0) root.style.setProperty(name, `${value}px`);
    };

    const update = () => {
        const bridge = window.HrtSafeArea;
        if (!bridge) return;
        setPx('--android-safe-top', bridge.top());
        setPx('--android-safe-bottom', bridge.bottom());
        // Only when the bridge has it; an older APK does not, and leaving the
        // property unset is the correct "no keyboard" reading.
        if (typeof bridge.ime === 'function') setPx('--android-ime-bottom', bridge.ime());
    };

    update();
    window.addEventListener('hrt-safe-area-change', update);

    // Per-frame during the keyboard's animation. The detail is dp, which is CSS
    // px at the WebView's default zoom — the same unit the bars are already in.
    window.addEventListener('hrt-ime-progress', event => {
        const detail = (event as CustomEvent<number>).detail;
        if (typeof detail === 'number') setPx('--android-ime-bottom', detail);
    });

    /*
     * Keep the focused field in view while the keyboard makes room for it.
     *
     * The WebView's height shrinks a little every frame of the keyboard's
     * animation (see `applyImeHeight` in `scripts/MainActivity.kt`), and each of
     * those changes reaches the page as a `resize` event. Chromium scrolls a
     * newly focused editable into view *once*, on focus, against the viewport it
     * had at that moment — which is the full-height one, before the keyboard has
     * taken anything. Fields near the bottom (the time picker's hour boxes, a
     * sheet's last input) therefore end up under the keyboard and never move: the
     * reported "点下面的小时，毫无变化".
     *
     * Re-scrolling on every resize frame keeps the field pinned above the
     * keyboard for the whole animation. `nearest` rather than `center`: a field
     * already visible must not be dragged around, which is also what keeps the
     * year input's case (it sits high on the page) perfectly still.
     */
    const focusedField = (): Element | null => {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement)) return null;
        return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : null;
    };
    const revealFocused = () => focusedField()?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    window.addEventListener('resize', revealFocused, { passive: true });
    // `focusin` rather than `focus`: it bubbles, so the inputs inside portals and
    // shadow-less custom fields are covered by one listener.
    document.addEventListener('focusin', () => {
        // One frame later: the focus click may itself be what dismisses the
        // keyboard, and scrolling before the WebView has resized scrolls to a
        // viewport that is about to change.
        requestAnimationFrame(revealFocused);
    }, { passive: true });
}
