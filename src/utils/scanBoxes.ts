import type { Region } from './ppocr'

/**
 * Turning detector geometry into screen geometry.
 *
 * The engine's 'Region' coordinates are in the pixel space of the buffer it was
 * handed ('OcrPage.width'/'height'), and the preview element is CSS-sized, so the two
 * only line up through the resize the browser already performed: the preview is an
 * '<img>' drawn with 'object-contain'. These two functions are that same resize, done
 * in numbers, which is what lets a box be positioned with the browser's own layout.
 *
 * Kept pure and separate from the component so the mapping can be checked without a
 * browser — see 'scripts/check-scan-boxes.mjs'. A wrong scale here is invisible as a
 * bug and obvious as nonsense: every box lands somewhere the text is not.
 */

/** A rendered element's content box, in CSS pixels. */
export interface ElementSize {
    width: number
    height: number
}

/** Where an 'object-contain' image actually lands inside its element. */
export interface ContentFit {
    /** Source pixels per CSS pixel. */
    scale: number
    /** The letterbox, in CSS pixels, on each axis. */
    offsetX: number
    offsetY: number
    /** The drawn image's size in CSS pixels. */
    width: number
    height: number
}

/** A box in the preview's CSS pixels. */
export interface DisplayBox {
    left: number
    top: number
    width: number
    height: number
}

/**
 * The content box 'object-contain' produces: scaled to fit, centred, aspect kept.
 *
 * A non-positive input is a degenerate element (an image that has not loaded, a
 * hidden panel). Returning an empty fit rather than NaN keeps the caller from
 * positioning boxes at 'NaNpx', which would throw every one of them away.
 */
export function fitContent(
    srcWidth: number,
    srcHeight: number,
    boxWidth: number,
    boxHeight: number,
): ContentFit {
    if (!(srcWidth > 0) || !(srcHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
        return { scale: 0, offsetX: 0, offsetY: 0, width: 0, height: 0 }
    }
    const scale = Math.min(boxWidth / srcWidth, boxHeight / srcHeight)
    const width = srcWidth * scale
    const height = srcHeight * scale
    return {
        scale,
        offsetX: (boxWidth - width) / 2,
        offsetY: (boxHeight - height) / 2,
        width,
        height,
    }
}

/** A detector Region in the preview's CSS pixels, ready for 'position: absolute'. */
export function regionToBox(region: Region, fit: ContentFit): DisplayBox {
    return {
        left: fit.offsetX + region.x0 * fit.scale,
        top: fit.offsetY + region.y0 * fit.scale,
        width: Math.max(0, (region.x1 - region.x0) * fit.scale),
        height: Math.max(0, (region.y1 - region.y0) * fit.scale),
    }
}
