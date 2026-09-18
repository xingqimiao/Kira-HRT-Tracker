// Type-only: erasable at build time, so this module has no runtime imports and
// `scripts/check-template-quick-add.mjs` can load it in plain Node.
import type { DoseEvent } from '../../logic';

/**
 * The fields a saved template carries. Structural rather than an import of
 * `DoseTemplate` so this stays usable from either declaration (`DoseForm`'s is
 * typed, `useAppData`'s is loose) without dragging a component into a util.
 */
export interface TemplateLike {
    route: DoseEvent['route'];
    ester: DoseEvent['ester'];
    doseMG: number;
    extras: DoseEvent['extras'];
}

/**
 * One tap on the overview page: a saved template becomes a real dose record at
 * `timeH`.
 *
 * Deliberately a plain function rather than a handler inside the component —
 * it is the whole of the feature's logic, so keeping it out here is what lets
 * `scripts/check-template-quick-add.mjs` exercise it without a DOM.
 *
 * `extras` is copied, never shared: a template is loaded repeatedly, and handing
 * the same object to two records would make editing one silently edit the other.
 */
export function templateToEvent(
    template: TemplateLike,
    id: string,
    timeH: number,
): DoseEvent {
    return {
        id,
        route: template.route,
        timeH,
        doseMG: template.doseMG,
        ester: template.ester,
        extras: { ...template.extras },
    };
}
