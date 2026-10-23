import type { ReactNode } from 'react';
import { ContainerTransform } from './ContainerTransform';

/**
 * A full-screen surface in the prototype's overlay idiom.
 *
 * It used to own the mount/exit state itself; the M3E container transform now
 * owns presence, the trigger geometry and the desktop modal, so this is only the
 * API the pages already speak. All five call sites get the shared transition for
 * free.
 */
export function FullScreenSheet({
    open,
    onClose,
    onReopen,
    title,
    children,
    bare = false,
}: {
    open: boolean;
    onClose: () => void;
    /** Reverse a close that is still animating — see `ContainerTransform`. */
    onReopen?: () => void;
    title: string;
    children: ReactNode;
    /**
     * Let the child own the chrome. The M3E dose panel already has its own
     * header and bottom bar; the History quick-add flow uses this so the sheet
     * does not stack a second title bar above it.
     */
    bare?: boolean;
}) {
    return (
        <ContainerTransform
            open={open}
            onClose={onClose}
            onReopen={onReopen}
            title={title}
            bare={bare}
        >
            {children}
        </ContainerTransform>
    );
}
