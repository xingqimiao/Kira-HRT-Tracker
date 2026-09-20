import React from 'react';
import xMark from '../assets/brands/x.svg?raw';
import googleMark from '../assets/brands/google.svg?raw';

/**
 * The two provider marks.
 *
 * These are **trademarks, not icons**, which is why they are the only artwork in
 * the app that is not a reicon glyph. reicon ships no brand marks — searching it
 * for "google logo" returns a magnifier, and for "x twitter social" returns
 * `xmark` — and a stand-in glyph would misrepresent the provider to the person
 * about to hand it their account. Do not replace either of these with something
 * from the icon set.
 *
 * Both files are the providers' own published SVG, byte for byte, kept in
 * `src/assets/brands` and imported raw. X's is `fill="currentColor"`, so it takes
 * the button's ink like every other icon; Google's carries its own four colours
 * and must not be recoloured. The size is the call site's, and the wrapper scales
 * the file to it.
 */
const BrandMark: React.FC<{ markup: string; size: number; className?: string }> = ({ markup, size, className }) => (
    <span
        className={'m3-brand-mark' + (className ? ' ' + className : '')}
        aria-hidden
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: markup }}
    />
);

export const XBrand: React.FC<{ size?: number; className?: string }> = ({ size = 18, className }) => (
    <BrandMark markup={xMark} size={size} className={className} />
);

export const GoogleBrand: React.FC<{ size?: number; className?: string }> = ({ size = 18, className }) => (
    <BrandMark markup={googleMark} size={size} className={className} />
);
