import { useEffect, useRef, type RefObject } from 'react';
import { onBackGesture } from './nativeBack';
import { springTo, SPRING } from './spring';

/**
 * Make a dismissible surface answer the predictive-back gesture.
 *
 * Registering a back handler closes a surface when the gesture commits; it says
 * nothing about the *preview* — the frames between the finger touching the edge
 * and lifting. Without this a surface sits perfectly still while the gesture
 * runs, then vanishes: motion that cannot respond to the reader, and the
 * reported "悬浮按钮打开的界面现在就没有预测性返回".
 *
 * ── The two poses ────────────────────────────────────────────────────────────
 *
 *   `sheet`  a bottom sheet translates down by `progress × its own height`, so a
 *            tall sheet travels further than a short one for the same gesture.
 *
 *   `card`   a full-screen panel scales into a rounded card leaning toward the
 *            finger's edge — the system's own back-to-home pose, read off the
 *            Settings screenshot the pose was matched against.
 *
 * Both are three compositor properties written per frame: no layout, no React
 * render, so the gesture never competes with the app for the same frame budget.
 * A cancelled gesture springs back with the shared solver, from rest — the
 * platform does not report the finger's velocity on cancel.
 *
 * The commit is *not* posed here. It arrives as `hrt-back`, closes the surface
 * through its own back handler, and this hook clears the inline styles the
 * moment `open` goes false: an inline transform left behind would override the
 * surface's CSS exit animation and freeze it mid-air for that animation's whole
 * duration — the reported "返回之后会卡一下".
 */
export type BackPoseKind = 'sheet' | 'card';

/** The card pose, matched against the system's predictive back preview. */
const CARD_SCALE = 0.1;
const CARD_RADIUS = 32;
const CARD_SHIFT = 12;

export function useBackPose(
    open: boolean,
    ref: RefObject<HTMLElement | null>,
    kind: BackPoseKind = 'sheet',
): void {
    const settle = useRef<(() => void) | null>(null);
    const value = useRef(0);
    const edge = useRef(-1);

    useEffect(() => {
        if (!open) return undefined;

        const apply = (p: number) => {
            value.current = p;
            const el = ref.current;
            if (!el) return;
            if (p <= 0) {
                el.style.transform = '';
                el.style.borderRadius = '';
                el.style.willChange = '';
                return;
            }
            el.style.willChange = 'transform';
            if (kind === 'sheet') {
                // `progress × height`: a tall sheet travels further than a short
                // one for the same gesture, which is what makes it read as
                // pushed rather than faded.
                el.style.transform = `translateY(${p * el.offsetHeight}px)`;
                return;
            }
            el.style.transform =
                `translate3d(${edge.current * p * CARD_SHIFT}px,0,0) scale(${1 - CARD_SCALE * p})`;
            el.style.borderRadius = `${CARD_RADIUS * p}px`;
        };

        const unsubscribe = onBackGesture({
            onStart: e => {
                edge.current = e === 1 ? 1 : -1;
                settle.current?.();
                settle.current = null;
                apply(0);
            },
            onProgress: apply,
            onCancel: () => {
                settle.current = springTo(value.current, 0, apply, { config: SPRING.SHEET });
            },
        });
        return () => {
            unsubscribe();
            settle.current?.();
            settle.current = null;
            apply(0);
        };
    }, [open, kind, ref]);

    // The surface is closing: drop the pose in the same commit that swaps in the
    // closing class, so the CSS exit transition starts from the finger's last
    // position instead of from a frozen inline transform.
    useEffect(() => {
        if (open) return;
        settle.current?.();
        settle.current = null;
        value.current = 0;
        const el = ref.current;
        if (!el) return;
        el.style.transform = '';
        el.style.borderRadius = '';
        el.style.willChange = '';
    }, [open, ref]);
}
