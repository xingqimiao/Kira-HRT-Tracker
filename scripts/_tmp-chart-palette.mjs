// One-off: point the chart at the app's colour roles instead of its own palette.
//
// The chart carried a terracotta palette of its own — `#CC785C`, `#D8927C`, `#E0A38C` —
// inherited from the upstream project and never migrated when the rest of the interface
// moved onto the Material role tokens. It was the last screen still showing the old
// product's colours: a warm salmon curve on a pink-and-blue app.
//
// The replacement reads the tokens at render time rather than importing a second copy,
// which is what makes it follow the light/dark switch and the pink/blue choice with no
// extra wiring — the same approach `VialSpray` already uses for its liquid.
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/components/ResultChart.tsx'
let s = readFileSync(FILE, 'utf8')

const old = `    // Warm, on-brand palette — terracotta primary against a muted neutral grid.
    const c = isDarkMode
        ? { primary: '#D8927C', second: '#7A776F', grid: '#2E2C28', axis: '#7A776F', faint: '#5C5953', dot: '#1C1B18', lab: '#E0A38C' }
        : { primary: '#CC785C', second: '#C2BDB3', grid: '#E7E4DD', axis: '#A8A59E', faint: '#C2BDB3', dot: '#FAF9F7', lab: '#B5664C' };`

const replacement = `    /**
     * The plotted colours, read from the app's role tokens.
     *
     * Read rather than imported so the chart follows whichever theme and key colour are
     * active without any prop threading — the tokens resolve on \`<html>\`, and every
     * other surface in the app already does this.
     *
     * It previously carried a terracotta palette of its own, inherited from upstream and
     * never migrated: a warm salmon curve on a pink-and-blue interface. \`isDarkMode\` is
     * still a dependency so a theme change re-reads, since a raw custom-property read
     * does not re-render on its own.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const c = useMemo(() => {
        const cs = getComputedStyle(document.documentElement);
        const role = (name: string, fallback: string) =>
            cs.getPropertyValue(name).trim() || fallback;
        return {
            primary: role('--color-m3-chart-series-1', '#2C6E8F'),
            second: role('--color-m3-chart-series-2', '#7A4E92'),
            grid: role('--color-m3-chart-grid', '#E4E5EA'),
            axis: role('--color-m3-chart-axis', '#6A6D78'),
            faint: role('--color-m3-chart-faint', '#B4B7C0'),
            dot: role('--color-m3-chart-marker', '#FFFFFF'),
            lab: role('--color-m3-chart-lab', '#A16207'),
        };
    }, [isDarkMode]);`

if (s.split(old).length !== 2) throw new Error(`palette block matched ${s.split(old).length - 1} times`)
s = s.replace(old, replacement)

// `useMemo` has to be imported.
if (!/\buseMemo\b/.test(s.slice(0, s.indexOf('\n\n')))) {
  const importLine = s.match(/import React[^\n]*\n/)
  if (!importLine) throw new Error('no React import line')
  if (!importLine[0].includes('useMemo')) {
    s = s.replace(importLine[0], importLine[0].replace('{', '{ useMemo, ').replace('{ useMemo, }', '{ useMemo }'))
  }
}

writeFileSync(FILE, s)
console.log('chart palette pointed at the role tokens')
