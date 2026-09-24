import React, { useState } from 'react';
import Icon from './Icon';
import { Plus, Trash2, ChevronDown, Check } from '../icons';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import DateTimePicker from './DateTimePicker';
import Collapsible from './Collapsible';
import { LOCALE_MAP } from '../utils/helpers';
import { JournalEntry } from '../utils/bodyJournal';

/**
 * The private journal, rendered on the 体检 (lab) section.
 *
 * One text field and a time. An earlier build put five 0–5 scales and a
 * three-group symptom checklist above the text, and the request was to keep only
 * what the user actually wrote — so there is nothing here to rate, tick or
 * categorise. Nothing derives a total, a threshold or advice from the text either;
 * the register note says so on screen.
 *
 * The time stays because it belongs to the record rather than to the writing: a
 * note is filed *at* something. Saving is refused while the field is empty, since
 * an entry with no words is not a record.
 */

const muted = 'text-[var(--color-m3-on-surface-variant)] ';
const on = 'text-[var(--color-m3-on-surface)] ';
const divider = 'border-b border-[var(--color-m3-outline-variant)] ';

/** A local ISO string for `datetime-local`, which is what the picker round-trips. */
const localIso = (date: Date): string =>
    new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

interface JournalCheckInProps {
    entries: JournalEntry[];
    onSave: (entry: JournalEntry) => void;
    onDelete: (id: string) => void;
}

const JournalCheckIn: React.FC<JournalCheckInProps> = ({ entries, onSave, onDelete }) => {
    const { t, lang } = useTranslation();
    const { showDialog } = useDialog();

    const [isOpen, setIsOpen] = useState(false);
    const [editing, setEditing] = useState<JournalEntry | null>(null);
    const [dateStr, setDateStr] = useState(() => localIso(new Date()));
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
    const [note, setNote] = useState('');

    const reset = () => {
        setEditing(null);
        setDateStr(localIso(new Date()));
        setNote('');
    };

    const openNew = () => {
        reset();
        setIsOpen(true);
    };

    const openEdit = (entry: JournalEntry) => {
        setEditing(entry);
        setDateStr(localIso(new Date(entry.timeH * 3600000)));
        setNote(entry.note);
        setIsOpen(true);
    };

    const close = () => {
        setIsOpen(false);
        reset();
    };

    // The one guard on the form: a note with no words is not a record, and storing
    // one would put a blank line in the middle of the log.
    const canSave = note.trim() !== '';

    const save = () => {
        if (!canSave) return;
        const when = new Date(dateStr);
        const timeH = Number.isFinite(when.getTime()) ? when.getTime() / 3600000 : Date.now() / 3600000;
        onSave({
            ...(editing ?? {}),
            id: editing?.id ?? uuidv4(),
            timeH,
            note: note.trim(),
        });
        close();
    };

    const confirmDelete = (entry: JournalEntry) => {
        showDialog('confirm', t('journal.delete_confirm'), () => onDelete(entry.id));
    };

    const sorted = [...entries].sort((a, b) => b.timeH - a.timeH);
    const when = (timeH: number) =>
        new Date(timeH * 3600000).toLocaleString(LOCALE_MAP[lang] || 'en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });

    return (
        <div className="mx-auto w-full px-6 md:px-8 max-w-2xl">
            <div className="flex items-center justify-between pt-2 pb-3">
                <div>
                    <h2 className={`text-m3-title-medium ${on}`}>{t('journal.section')}</h2>
                    <p className={`text-xs ${muted} mt-0.5`}>
                        {sorted.length} {t('journal.count')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => (isOpen ? close() : openNew())}
                    className="flex items-center gap-1.5 text-sm font-medium px-2 py-1 rounded-md text-[var(--color-m3-primary)] hover:bg-[var(--color-m3-surface-container)] "
                >
                    <Icon icon={Plus} size={15} className={isOpen ? 'rotate-45' : ''} />
                    <span>{isOpen ? t('btn.cancel') : t('journal.add')}</span>
                </button>
            </div>

            <p className={`text-xs ${muted} pb-3`}>{t('journal.register')}</p>

            {/* Collapsible, not `isOpen &&`: the editor used to appear at full height
                in one frame, so the whole page jumped down the moment 记录 was tapped.
                It carries the app's 250ms grid-rows pair and holds the panel through
                the close, so cancelling eases it away instead of blanking it. */}
            <Collapsible open={isOpen} className="mb-6">
                <div className="rounded-lg border border-[var(--color-m3-outline-variant)] overflow-hidden">
                    <button
                        type="button"
                        onClick={() => setIsDatePickerOpen(v => !v)}
                        className={`w-full flex items-center justify-between px-4 py-3 ${divider} text-start`}
                    >
                        <span className={`text-m3-body-medium ${on}`}>{t('journal.time')}</span>
                        <div className={`flex items-center gap-1.5 ${muted}`}>
                            <span className="text-sm tabular-nums">
                                {when(new Date(dateStr).getTime() / 3600000)}
                            </span>
                            <Icon icon={ChevronDown} size={14} className={isDatePickerOpen ? 'rotate-180' : ''} />
                        </div>
                    </button>
                    {/* DateTimePicker owns the disclosure motion — nothing to
                        wrap here. */}
                    <DateTimePicker
                        isOpen={isDatePickerOpen}
                        inline
                        onClose={() => setIsDatePickerOpen(false)}
                        onConfirm={date => setDateStr(localIso(date))}
                        initialDate={new Date(dateStr)}
                        mode="datetime"
                        title={t('journal.time')}
                    />
                    <div className="px-4 py-3">
                        <label className={`block text-m3-body-medium ${on}`} htmlFor="journal-note">
                            {t('journal.note')}
                        </label>
                        <textarea
                            id="journal-note"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                            placeholder={t('journal.note_placeholder')}
                            rows={5}
                            maxLength={2000}
                            className={`input-base mt-2 resize-y text-sm ${on}`}
                        />
                    </div>

                    <div className="flex items-center justify-end gap-2 px-4 py-3">
                        <button
                            type="button"
                            onClick={close}
                            className={`px-3 py-1.5 rounded-md text-sm ${muted} hover:bg-[var(--color-m3-surface-container)]`}
                        >
                            {t('btn.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={save}
                            disabled={!canSave}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)] disabled:opacity-40"
                        >
                            <Icon icon={Check} size={14} />
                            <span>{t('btn.save')}</span>
                        </button>
                    </div>
                </div>
            </Collapsible>

            {sorted.length === 0 ? (
                <p className={`text-sm ${muted} py-6 text-center`}>{t('journal.empty')}</p>
            ) : (
                <div>
                    {sorted.map(entry => (
                        <div key={entry.id} className={`py-3 ${divider} last:border-b-0`}>
                            <div className="flex items-start justify-between gap-3">
                                <button
                                    type="button"
                                    onClick={() => openEdit(entry)}
                                    className="flex-1 min-w-0 text-start"
                                >
                                    <span className={`block text-xs tabular-nums ${muted}`}>
                                        {when(entry.timeH)}
                                    </span>
                                    <span className={`block mt-1 text-sm ${on} whitespace-pre-wrap break-words`}>
                                        {entry.note}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => confirmDelete(entry)}
                                    aria-label={t('btn.delete')}
                                    className={`shrink-0 p-1.5 rounded-md hover:bg-[var(--color-m3-surface-container)] ${muted}`}
                                >
                                    <Icon icon={Trash2} size={14} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default JournalCheckIn;
