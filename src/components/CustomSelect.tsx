import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import Icon from './Icon';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from '../icons';

interface Option {
    value: string;
    label: string;
    icon?: React.ReactNode;
    description?: string;
}

interface CustomSelectProps {
    value: string;
    onChange: (val: string) => void;
    options: Option[];
    label?: string;
    icon?: React.ReactNode;
}

const CustomSelect: React.FC<CustomSelectProps> = ({ value, onChange, options, label, icon }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [positionStyle, setPositionStyle] = useState<React.CSSProperties>({});
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (typeof document !== 'undefined') {
            setPortalTarget(document.body);
        }
    }, []);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                (containerRef.current && containerRef.current.contains(event.target as Node)) ||
                (dropdownRef.current && dropdownRef.current.contains(event.target as Node))
            ) {
                return;
            }
            setIsOpen(false);
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    useLayoutEffect(() => {
        if (isOpen && containerRef.current) {
            const updatePosition = () => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (rect) {
                    const spaceBelow = window.innerHeight - rect.bottom;
                    const spaceAbove = rect.top;
                    const minSpaceBelow = 240;

                    let shouldFlip = false;
                    let maxHeight = 320;

                    if (spaceBelow < minSpaceBelow && spaceAbove > spaceBelow) {
                        shouldFlip = true;
                        maxHeight = Math.min(320, spaceAbove - 24);
                    } else {
                        shouldFlip = false;
                        maxHeight = Math.min(320, spaceBelow - 24);
                    }

                    if (shouldFlip) {
                        setPositionStyle({
                            bottom: window.innerHeight - rect.top + 4,
                            left: rect.left,
                            width: rect.width,
                            maxHeight: maxHeight
                        });
                    } else {
                        setPositionStyle({
                            top: rect.bottom + 4,
                            left: rect.left,
                            width: rect.width,
                            maxHeight: maxHeight
                        });
                    }
                }
            };
            updatePosition();
            window.addEventListener('resize', updatePosition);
            window.addEventListener('scroll', updatePosition, { capture: true, passive: true });
            return () => {
                window.removeEventListener('resize', updatePosition);
                window.removeEventListener('scroll', updatePosition, { capture: true });
            };
        }
    }, [isOpen]);

    const selectedOption = options.find(o => o.value === value);

    const handleSelect = (val: string) => {
        onChange(val);
        setIsOpen(false);
    };

    return (
        <div className="space-y-1.5 flex flex-col" ref={containerRef}>
            {label && !icon && (
                <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">
                    {label}
                </label>
            )}

            <div className="relative">
                <button
                    type="button"
                    onClick={() => setIsOpen(!isOpen)}
                    className={`group w-full min-h-[44px] px-3 py-2 bg-cos-surface-container  border outline-none flex items-center justify-between overflow-hidden
                        ${isOpen
                            ? 'border-[var(--color-m3-primary)] shadow-[inset_0_0_0_1px_var(--color-m3-primary)] rounded-t-md'
                            : 'border-cos-outline  hover:border-cos-outline  rounded-md'}`}
                >
                    {icon ? (
                        <>
                            <div className="flex items-center gap-2">
                                {icon}
                                <span className="font-medium text-cos-on-surface  text-sm">{label}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span className="text-sm text-cos-on-surface-variant">{selectedOption?.label}</span>
                                <Icon icon={ChevronDown} size={16} className={`chev text-cos-outline ${isOpen ? 'rotate-180' : ''}`} />
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                {selectedOption?.icon && <div className="text-cos-on-surface-variant ">{selectedOption.icon}</div>}
                                <span className="font-medium text-cos-on-surface  text-sm truncate">{selectedOption?.label || value}</span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                                {selectedOption?.description && (
                                    <span className="text-xs text-cos-on-surface-variant ">{selectedOption.description}</span>
                                )}
                                <Icon icon={ChevronDown} size={16} className={`chev text-cos-outline ${isOpen ? 'rotate-180' : ''}`} />
                            </div>
                        </>
                    )}
                </button>

                {isOpen && portalTarget && createPortal(
                    <div
                        ref={dropdownRef}
                        style={positionStyle}
                        className="dropdown-in fixed z-[999] bg-cos-surface-container  border border-cos-outline  border-t-0 rounded-b-md shadow-sm overflow-y-auto py-1"
                    >
                        {options.map(opt => (
                            <button
                                key={opt.value}
                                onClick={() => handleSelect(opt.value)}
                                className={`w-full px-3 py-2 text-start flex items-center gap-2 relative overflow-hidden
                                    ${opt.value === value
                                        ? 'bg-[var(--color-m3-primary-container)] text-[var(--color-m3-on-surface)] font-medium'
                                        : 'text-cos-on-surface  hover:bg-cos-surface-container '}`}
                            >
                                {opt.icon && <div className="text-cos-outline ">{opt.icon}</div>}
                                <span className="flex-1 text-sm">{opt.label}</span>
                                {opt.description && (
                                    <span className={`text-xs ${opt.value === value ? 'text-[var(--color-m3-on-surface-variant)]' : 'text-cos-on-surface-variant '}`}>
                                        {opt.description}
                                    </span>
                                )}
                                {opt.value === value && (
                                    <Icon icon={Check} size={16} className="text-[var(--color-m3-primary)]" strokeWidth={2.5} />
                                )}
                            </button>
                        ))}
                    </div>,
                    portalTarget
                )}
            </div>
        </div>
    );
};

export default CustomSelect;
