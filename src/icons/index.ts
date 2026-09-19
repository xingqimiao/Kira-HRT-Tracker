/**
 * The app's icon set.
 *
 * Every glyph is a real `reicon` icon. This file is the one place an icon is named,
 * so nothing reaches into the library directly and nothing hand-draws a path.
 *
 * The names on the left are the vocabulary the app has always used (inherited from
 * lucide); the names on the right are the reicon icons that replace them. Keeping
 * the old names means the ~250 call sites did not have to change when the drawings
 * did — a rename would have buried the real change in a mechanical diff.
 *
 * `./compat` used to hold 31 frozen lucide paths for glyphs reicon was assumed not
 * to ship. It shipped all of them; the file is gone.
 */

export {
    Activity,
    AlertCircle,
    AlertTriangle,
    ArrowLeft,
    Atom,
    Bookmark,
    CalendarDays,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Clock3,
    CodeFile,
    Cloud,
    Copy,
    Database,
    Dna,
    Download,
    Droplet,
    Edit2,
    Eye,
    EyeOff,
    FastForward,
    Fingerprint,
    Gauge,
    Globe,
    HardDrive,
    Home,
    ImagePlus,
    Link2,
    Lock,
    LockKeyhole,
    Minus,
    Monitor,
    PenLine,
    Pill,
    Plus,
    Radar,
    Rewind,
    Save,
    Scan,
    Search,
    Server,
    Settings,
    Settings2,
    Shield,
    ShieldCheck,
    ShieldOff,
    Sticker,
    Syringe,
    Trash,
    Trash2,
    Upload,
    UserCircle,
    Users,
    Wind,
    X,
} from 'reicon';

/** reicon ships this as `Settings`; the app has always called it `SettingsIcon`. */
export { Settings as SettingsIcon } from 'reicon';

/* The former `./compat` set. Each of these is now the reicon glyph that was asked
   for, under the name the app already used. */
export {
    BookmarkAdd as BookmarkPlus,
    CheckCircle as CheckCircle2,
    Ban as CircleOff,
    ArrowUpRight as ExternalLink,
    Flask as FlaskConical,
    Benzene as Hexagon,
    InfoCircle as Info,
    Key as KeyRound,
    Checklist as ListChecks,
    List as ListTodo,
    Loader as Loader2,
    Logout as LogOut,
    MonitorPhone as MonitorSmartphone,
    Planet as Orbit,
    Refresh as RefreshCw,
    RotateLeft as RotateCcw,
    Share as Share2,
    Leaf as Shell,
    LinkBroken as Unlink,
} from 'reicon';

/** The Lab tab. The app's hand-drawn curve is now reicon's chart line. */
export { ChartLine as CalibrationCurve } from 'reicon';

// reicon has no `LucideIcon`; call sites use this as the icon-function type.
export type { IconFunction as IconComponent, IconWeight } from 'reicon';
