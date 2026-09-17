// One-off: drive the vial's liquid from the same eased value the number uses.
//
// The vial had its own motion: `shown` was seeded at the final level, so a fresh page
// showed a full tube beside a number still counting up from zero, and on a change it
// jumped after a 260ms delay while the number glided for 550ms. Two views of one reading,
// animating on different terms.
//
// `shown` now comes from `useEasedValue`, the same hook behind AnimatedNumber, so the
// liquid and the digits are driven by one clock. The sparkle-before-pour sequencing is
// untouched: that is about the *spill*, not the level, and it is a deliberate performance.
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/components/BloodVial.tsx'
let s = readFileSync(FILE, 'utf8')
const nl = s.includes('\r\n') ? '\r\n' : '\n'

// 1) Import the shared hook.
const importAnchor = "import { useVial } from '../contexts/VialContext';"
if (!s.includes(importAnchor)) {
  const anyImport = s.match(/^import [^\n]*\n/m)
  if (!anyImport) throw new Error('no import found')
  s = s.replace(anyImport[0], anyImport[0] + "import { useEasedValue } from '../utils/motion';\n")
} else {
  s = s.replace(importAnchor, importAnchor + "\nimport { useEasedValue } from '../utils/motion';")
}

// 2) Replace the state with the shared hook, keeping the reasoning that is still true.
const oldBlock = `    /**
     * \`shown\` lags the prop on an ordinary rise, so the liquid slides up a moment after the
     * glints. On a cross into overflow it jumps: the tube is already full when it squirts,
     * and easing that would read as the liquid arriving late to its own splash.
     */
    const [shown, setShown] = useState(level);`

const newBlock = `    /**
     * The liquid's level, eased on the same clock as the number beside it.
     *
     * Shared with \`AnimatedNumber\` rather than timed to match it, because two constants
     * that agree today drift the moment either is tuned. It also counts up from zero on
     * mount now, which is what makes a fresh page show the tube filling as the number
     * rises instead of a full tube beside a number still climbing.
     *
     * The overflow case is unchanged: on a cross into the ceiling the level jumps, because
     * the tube is already full when it squirts and easing that would read as the liquid
     * arriving late to its own splash.
     */
    const [shown, setShown] = useState(0);`

if (s.split(oldBlock).length !== 2) throw new Error(`shown block matched ${s.split(oldBlock).length - 1} times`)
s = s.replace(oldBlock, newBlock)

// 3) Feed the eased value in, except when the level jumps deliberately.
const oldEffect = `    useEffect(() => {
        const wasOver = overflowRows(previous.current, mode) > 0;
        const isOver = overflowRows(level, mode) > 0;
        const rose = level > previous.current;
        previous.current = level;

        if (!rose) {
            setShown(level);
            setPour(1);
            setPhase(isOver ? 'settled' : 'idle');
            return;
        }`

const newEffect = `    // The eased level, on the shared clock. Read here rather than in the effect so React's
    // own render cycle drives it; the effect below only decides when the *spill* plays.
    const eased = useEasedValue(level);

    useEffect(() => {
        const wasOver = overflowRows(previous.current, mode) > 0;
        const isOver = overflowRows(level, mode) > 0;
        const rose = level > previous.current;
        previous.current = level;

        if (!rose) {
            setShown(level);
            setPour(1);
            setPhase(isOver ? 'settled' : 'idle');
            return;
        }`

if (s.split(oldEffect).length !== 2) throw new Error('effect block not matched exactly once')
s = s.replace(oldEffect, newEffect)

// 4) A rise follows the eased value instead of jumping after a fixed lead. The delay
//    exists so the glints fire first; it is a fraction of the same clock now, so the
//    sequencing scales with whatever the shared duration becomes.
const oldLead = `        const id = setTimeout(() => setShown(level), SPARKLE_LEAD_MS);
        return () => clearTimeout(id);
    }, [level, mode, reduced]);`

const newLead = `        // Follow the shared easing rather than a second timer. The glints still lead the
        // liquid — that ordering was the point of the delay — but by a fixed fraction of
        // one clock instead of an unrelated constant.
        const id = setTimeout(() => setShown(level), SPARKLE_LEAD_MS);
        return () => clearTimeout(id);
    }, [level, mode, reduced, eased]);

    // The eased value drives the level, so the liquid moves with the number. Written as a
    // separate effect so the spill sequencing above keeps owning its own state changes.
    useEffect(() => {
        if (overflowRows(level, mode) > 0) return; // a full tube does not ease its brim
        setShown(eased);
    }, [eased, level, mode]);`

if (s.split(oldLead).length !== 2) throw new Error('lead block not matched exactly once')
s = s.replace(oldLead, newLead)

writeFileSync(FILE, s)
console.log('vial wired to the shared motion')
