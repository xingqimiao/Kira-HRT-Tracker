type AndroidSafeArea = { top(): number; bottom(): number };

declare global {
    interface Window { HrtSafeArea?: AndroidSafeArea }
}

export function initAndroidSafeArea(): void {
    const update = () => {
        const bridge = window.HrtSafeArea;
        if (!bridge) return;
        const top = bridge.top();
        const bottom = bridge.bottom();
        if (Number.isFinite(top) && top >= 0) document.documentElement.style.setProperty('--android-safe-top', `${top}px`);
        if (Number.isFinite(bottom) && bottom >= 0) document.documentElement.style.setProperty('--android-safe-bottom', `${bottom}px`);
    };
    update();
    window.addEventListener('hrt-safe-area-change', update);
}
