// The floor-plan model (Phase 1). This is the wire and storage format: the panel sends it to
// `chartroom/plans/save`, the integration stores it as-is, and the renderer reads it. Field names are
// snake_case to match Home Assistant's own APIs.
//
// Coordinates are metres in plan space: x to the right, y down (the same orientation as SVG), with
// the origin at the top-left of the plan's outline. See docs/render-design.md, "What Phase 1 must
// provide".
import type { PLAN_SCHEMA_VERSION } from './constants';
import type { Point, SourceKind, Window } from './types';

/**
 * A wall material. Radio loss through a wall is `db_per_cm * thickness_cm`; the shader reads it from
 * the wall texture, so adding materials costs nothing per pixel.
 */
export interface Material {
  id: string;
  name: string;
  /** Signal loss in dB per centimetre of thickness (2.4 GHz ballpark; Phase 4 can fit it). */
  db_per_cm: number;
}

/** A straight wall: centreline from `a` to `b`, with its full thickness and material. */
export interface Wall {
  id: string;
  a: Point;
  b: Point;
  /** Full thickness in metres, centred on the a–b line. */
  thickness: number;
  material: string;
}

/** Shared by doors and windows: a gap in a wall, measured along it from the wall's `a` end. */
export interface Opening {
  id: string;
  wall: string;
  /** Distance in metres from the wall's `a` end to the near edge of the opening. */
  offset: number;
  /** Width of the opening along the wall, in metres. */
  width: number;
  /** What fills the opening when it is closed, and how thick that is (metres). */
  material: string;
  thickness: number;
  /** Optional binary sensor / cover that says whether it is open. */
  entity_id?: string | null;
}

export interface Door extends Opening {
  /** Which edge of the opening carries the hinge: the one nearer the wall's `a` end, or `b` end. */
  hinge: 'a' | 'b';
  /**
   * Which side of the wall the leaf swings into, as the sign of the 2D cross product
   * `(b - a) x (p - a)` for points `p` on that side (in plan space, y down).
   */
  swing: 1 | -1;
}

export interface Room {
  id: string;
  name: string;
  /** Inner faces of the walls, in order (either winding). */
  polygon: Point[];
  /**
   * The Home Assistant areas this room shows, if any: more than one where areas share an open-plan
   * space (kitchen and living room). Plans saved before this had a single `area_id`, which
   * `normalizePlan` folds into this list.
   */
  area_ids?: string[];
}

/** Something the signal layer traces from: an access point or a radio. */
export interface Source {
  id: string;
  kind: SourceKind;
  entity_id: string;
  position: Point;
  /** The Home Assistant area the entity belongs to, if any (several areas can share one room). */
  area_id?: string | null;
  /** Radios and access points: transmit power or reference loss at 1 m, in dBm. */
  tx_dbm?: number;
}

/**
 * A raster or SVG drawing shown under the plan to trace over. The file itself is stored by the
 * integration (`/api/chartroom/underlay/<plan_id>`); the plan only says where it sits.
 */
export interface Underlay {
  /** URL path of the stored image, relative to Home Assistant. */
  url: string;
  /** Natural size of the image in pixels. */
  width_px: number;
  height_px: number;
  /** Metres per image pixel. */
  scale: number;
  /** Plan position of the image's top-left corner, in metres. */
  origin: Point;
  /** 0..1 */
  opacity: number;
}

/**
 * A Home Assistant device shown as one live marker on the plan: a light, a door sensor, a
 * temperature and humidity sensor. With `device_id`, the item stands for that device's entities
 * (as the registry has them, without hidden and config/diagnostic ones) and feeds every layer one
 * of them fits; without it, for `entity_id` alone (helpers and template sensors have no device).
 * Its name, icon and state come from Home Assistant (device-entities.ts).
 */
export interface Device {
  id: string;
  /**
   * The entity it was placed by: always one of its entities, and the one it shows while the
   * registry does not know the device.
   */
  entity_id: string;
  device_id?: string | null;
  /**
   * Entities of the device left out of the item (say a smart plug's unreliable temperature): no
   * layer, popover or menu shows them. Never `entity_id`; missing when none are.
   */
  exclude?: string[];
  position: Point;
}

export interface Plan {
  schema_version: typeof PLAN_SCHEMA_VERSION;
  name: string;
  floor_id?: string | null;
  /** Exterior polygon (outer faces of the outer walls), so the outside fade knows what is inside. */
  outline: Point[];
  walls: Wall[];
  rooms: Room[];
  doors: Door[];
  windows: Window[];
  /** Access points and radios. */
  sources: Source[];
  /** Live device markers, sensors among them. Plans from before markers have none. */
  devices?: Device[];
  /** Materials added to or overriding DEFAULT_MATERIALS. */
  materials?: Material[];
  underlay?: Underlay | null;
}
