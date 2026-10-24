// Keeps heatmap value labels off the room names. Text boxes are estimated from the font size and
// character count (no layout reads), so this is cheap enough to run on every pan or zoom.

/** A text label in plan units: centred on `x`, baseline at `y`, `size` the font size. */
export interface Label {
  x: number;
  y: number;
  size: number;
  chars: number;
}

/** Where each value label went: above its sensor, below it, or hidden. */
export type Placement = 'above' | 'below' | 'hidden';

export interface Decluttered {
  values: Placement[];
  /** Area labels ("12.3 m²") hidden, by room index. */
  areas: boolean[];
}

/** Room name and area font sizes in plan units (metres), as in the plan CSS. */
export const NAME_SIZE = 0.32;
export const AREA_SIZE = 0.24;

/** Area labels go when they would be smaller than this on screen (px). */
export const MIN_AREA_PX = 7;
/** Value label offset from the sensor, and font size, in screen pixels. */
export const VALUE_OFFSET_PX = 10;
export const VALUE_BELOW_PX = 22;
export const VALUE_FONT_PX = 12;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function box(l: Label, width = 0.58, pad = 0): Box {
  const w = (l.chars * width * l.size) / 2 + pad;
  return { x0: l.x - w, x1: l.x + w, y0: l.y - 0.78 * l.size - pad, y1: l.y + 0.22 * l.size + pad };
}

function hits(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Place value labels (`values`: sensor positions with their text length) so they clear the room
 * names and each other. A label that hits an area label hides the area label; one that still hits
 * a name, or an earlier value label, tries below its sensor, and is hidden if that fails too.
 * `mpp` is metres per screen pixel.
 */
export function declutter(
  values: { x: number; y: number; chars: number }[],
  rooms: { name: Label; area: Label }[],
  mpp: number,
): Decluttered {
  const small = rooms.map((r) => r.area.size / mpp < MIN_AREA_PX);
  const areas = [...small];
  const names = rooms.map((r) => box(r.name, 0.55));
  const areaBoxes = rooms.map((r) => box(r.area, 0.55));
  const placed: Box[] = [];
  const pad = 2 * mpp;
  const out = values.map((v): Placement => {
    for (const where of ['above', 'below'] as const) {
      const dy = where === 'above' ? -VALUE_OFFSET_PX : VALUE_BELOW_PX;
      const b = box(
        { x: v.x, y: v.y + dy * mpp, size: VALUE_FONT_PX * mpp, chars: v.chars },
        0.62,
        pad,
      );
      if (names.some((n) => hits(b, n)) || placed.some((p) => hits(b, p))) continue;
      // An area label gives way, except to a "below" label (the room name stays readable anyway).
      areaBoxes.forEach((a, i) => {
        if (!areas[i] && hits(b, a)) areas[i] = true;
      });
      placed.push(b);
      return where;
    }
    return 'hidden';
  });
  return { values: out, areas };
}
