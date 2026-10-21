import { useEffect } from 'react';

/**
 * The prototype has two shells, selected by a `desktop` class on `<body>`: a
 * bottom bar under 760px and a 96px navigation rail above it. Mirroring the
 * class is all that is needed — every `body.desktop …` rule in `src/m3e.css`
 * then applies exactly as it does in the prototype.
 */
export function useViewportMode(breakpoint = 760): void {
    useEffect(() => {
        const apply = () => {
            const params = new URLSearchParams(window.location.search);
            const forceMobile = params.has('mobile') || params.get('mode') === 'mobile';
            const isDesktop = forceMobile ? false : window.innerWidth >= breakpoint;
            document.body.classList.toggle('desktop', isDesktop);
            document.documentElement.classList.toggle('desktop', isDesktop);
            document.documentElement.classList.toggle('force-mobile', forceMobile && window.innerWidth >= breakpoint);
        };
        apply();
        window.addEventListener('resize', apply);
        window.addEventListener('orientationchange', apply);
        return () => {
            window.removeEventListener('resize', apply);
            window.removeEventListener('orientationchange', apply);
        };
    }, [breakpoint]);
}
