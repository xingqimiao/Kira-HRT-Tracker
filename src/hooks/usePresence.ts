import { useEffect, useRef, useState } from 'react';

/**
 * Keep a component mounted long enough to animate out.
 *
 * The modals in this app render as `if (!isOpen) return null`, which makes an exit
 * animation impossible — the node is gone on the same frame the state flips. This
 * returns the two things such a component needs: whether to render at all, and
 * which animation state to put on the DOM.
 *
 * ```tsx
 * const { mounted, state } = usePresence(isOpen);
 * if (!mounted) return null;
 * return <div className="modal-overlay" data-state={state}>…</div>;
 * ```
 *
 * The `data-state` attribute is what the CSS keys off, and it is why the attribute
 * is additive in the stylesheet: a modal that has not adopted this hook still gets
 * its entrance animation from the bare class.
 */
export function usePresence(open: boolean, exitMs = 200): {
  mounted: boolean;
  state: 'open' | 'closed';
} {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<'open' | 'closed'>(open ? 'open' : 'closed');

  // Reduced motion must skip the exit wait entirely: holding a surface in the DOM
  // for 200ms just to fade it is exactly the kind of delay the preference asks us
  // not to impose. Read at effect time rather than in render so a change to the OS
  // setting is picked up on the next transition.
  const reducedRef = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedRef.current = mq.matches;
    const onChange = () => {
      reducedRef.current = mq.matches;
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (open) {
      // Mount first, then flip to `open` on the next frame. Setting both in one
      // commit would apply the finished state immediately and the entrance
      // animation would never play.
      setMounted(true);
      const frame = requestAnimationFrame(() => setState('open'));
      return () => cancelAnimationFrame(frame);
    }

    setState('closed');
    const delay = reducedRef.current ? 0 : exitMs;
    if (delay === 0) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), delay);
    return () => clearTimeout(timer);
  }, [open, exitMs]);

  return { mounted, state };
}
