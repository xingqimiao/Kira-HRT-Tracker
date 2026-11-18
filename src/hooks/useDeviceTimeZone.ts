import { useEffect, useState } from 'react';
import { deviceTimeZone } from '../utils/timezone';

export function useDeviceTimeZone(): string {
    const [zone, setZone] = useState(deviceTimeZone);
    useEffect(() => {
        const refresh = () => setZone(deviceTimeZone());
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        window.addEventListener('hrt-timezone-changed', refresh);
        return () => {
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('focus', refresh);
            window.removeEventListener('hrt-timezone-changed', refresh);
        };
    }, []);
    return zone;
}
