import { Route, Ester } from '../../../logic';

/**
 * A saved one-tap dose shown in the record panel. The old button renderer that
 * lived here was superseded by the `.li` quick-dose rows in `DoseForm`; only the
 * shared shape remains.
 */
export interface QuickDose {
    id: string;
    route: Route;
    ester: Ester;
    value: number;
    createdAt: number;
}
