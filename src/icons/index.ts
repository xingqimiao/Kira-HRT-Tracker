/**
 * The app's icon set.
 *
 * Every glyph comes from `reicon`, re-exported here so call sites import from one
 * place and nothing reaches into the library directly. Names keep the vocabulary
 * the app already had, so the migration was a change of source rather than a
 * change of wording at 250 call sites.
 *
 * `./compat` holds the few glyphs reicon does not ship, in reicon's own shape.
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

export {
    BadgeCheck,
    BookmarkPlus,
    CheckCircle2,
    CircleOff,
    CloudOff,
    DownloadCloud,
    ExternalLink,
    FlaskConical,
    Flame,
    Hexagon,
    ImageOff,
    Info,
    KeyRound,
    ListChecks,
    ListTodo,
    Loader2,
    LogOut,
    Megaphone,
    Merge,
    MonitorSmartphone,
    Orbit,
    RefreshCw,
    RotateCcw,
    Share2,
    Shell,
    Smartphone,
    Unlink,
    UploadCloud,
} from './compat';

/** The app's own drawings, in the same shape as the reicon ones. */
export { CalibrationCurve, ShieldSoft } from './custom';

// reicon has no `LucideIcon`; call sites use this as the icon-function type.
export type { IconFunction as IconComponent, IconWeight } from 'reicon';
