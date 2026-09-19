/**
 * The component layer, as far as this branch keeps it.
 *
 * The rewrite built 23 components (`rewrite-ui` tag, `docs/ui-rewrite.md`). This
 * branch kept three of them, because these three are a *layout* change that the
 * rest of the interface does not depend on: the two navigation surfaces and the
 * shell that chooses between them.
 *
 * Everything else went back to the markup it had before the rewrite.
 */

export { default as AppShell } from './AppShell';
export { default as NavigationBar } from './NavigationBar';
export { default as NavigationRail } from './NavigationRail';
export { default as Progress } from './Progress';
export { default as Tooltip } from './Tooltip';
export type { NavDestination } from './NavigationRail';
