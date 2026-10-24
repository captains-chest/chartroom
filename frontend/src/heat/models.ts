import type { FieldGrid, FieldMesh } from '../field';
import type { FieldPlan } from '../field-plan';
import type { Point } from '../plan/types';
import type { SignalInput } from '../signal';
import type { View } from '../viewport';
import type { HeatLayerId, RampStop, RendererKind } from './types';

export interface LayerSpec {
  id: HeatLayerId;
  label: string;
  ramp: readonly RampStop[];
  /** The range the ramp spans at least, per unit; it grows to include the readings. */
  domain: Record<string, readonly [number, number]>;
  /** Decimals for labels. */
  digits: number;
  /** The range is fixed (it does not grow to include the readings). */
  fixed?: boolean;
}

/** A sensor reading used by a layer, or why a placed sensor was left out. */
export interface LayerReading {
  id: string;
  entity_id: string;
  position: Point;
  value: number;
}

export interface LayerData {
  layer: HeatLayerId;
  unit: string;
  readings: LayerReading[];
  /** Placed sensors of this layer that were left out (unavailable, unknown, not a number…). */
  excluded: { id: string; entity_id: string; position: Point; reason: string }[];
}

/** A sensor layout: what a renderer needs to compute the field for its readings. */
export interface Layout {
  readonly key: string;
  /** The sensor nodes, or null for the traced signal layer. */
  readonly mesh: FieldMesh | null;
  /** The per-cell node weights the worker planned (temperature and humidity). */
  readonly field?: FieldPlan;
  readonly grid: FieldGrid;
  /** The readings' ids, in the order `FieldRenderer.setValues` takes their values. */
  readonly ids: string[];
  readonly outline: Point[];
  readonly signal?: SignalInput;
}

/**
 * Draws a layout's field into one canvas: WebGL2 (gl-renderer.ts) or the Canvas2D fallback fed by
 * the field worker (canvas-renderer.ts). Both keep the previous field for a cross-fade.
 */
export interface FieldRenderer {
  readonly kind: RendererKind;
  /** A field is being computed off the main thread; `draw` shows the last one meanwhile. */
  readonly busy: boolean;
  /** The colour ramp, 256 RGBA entries (rampLut in heat/functions.ts). */
  setRamp(lut: Uint8Array): void;
  /** A new layout; with `fade` the current field stays as the cross-fade source. */
  setLayout(layout: Layout, fade: boolean): void;
  /** The (eased) reading values, in `layout.ids` order; the traced signal layer ignores them. */
  setValues(values: number[]): void;
  /** Colour the field for `view`, `mix` (0..1) of the way from the previous field to this one. */
  draw(view: View, domain: readonly [number, number], opacity: number, mix: number): void;
  /** Forget the previous field once a cross-fade finishes. */
  dropPrevious(): void;
  /**
   * The test probe (e2e/heat-debug.ts): the current field, value, confidence and fade per cell,
   * row by row from the grid origin; null before the first field.
   */
  readField(): Float32Array | null;
  dispose(): void;
}

/** What the legend shows, worked out from the readings (legend.ts). */
export interface LegendContent {
  title: string;
  unit: string;
  /** CSS background of the colour bar. */
  ramp: string;
  /** Marks for the lowest and highest reading: class, position along the bar (CSS), tooltip. */
  ticks: { cls: 'min' | 'max'; left: string; title: string }[];
  /** Low, middle and high end of the range, formatted. */
  scale: string[];
  note: string[];
  /** The accessible name. */
  label: string;
}
