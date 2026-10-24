// Messages between the main thread and the field worker. The worker triangulates the sensor
// layout once per change ('mesh') and then turns sensor values into a field grid ('values'); for
// the signal layer it traces the whole field in one go ('signal', the Canvas2D fallback).
import { nodeValues, type FieldGrid, type FieldMesh } from './field';
import { fillField, planField, type FieldPlan } from './field-plan';
import type { Point } from './plan';
import { MAX_SIGNAL_SEGMENTS, MAX_SIGNAL_SOURCES, SEG, SRC, signalField } from './signal';

export type WorkerRequest =
  | { type: 'ping'; id: number }
  | {
      type: 'mesh';
      id: number;
      key: string;
      sensors: Point[];
      outline: Point[];
      grid: FieldGrid;
      /** Barrier segments, four floats each (signal.ts barrierSegments), and room polygons. */
      walls?: ArrayLike<number>;
      rooms?: Point[][];
    }
  | { type: 'values'; id: number; key: string; values: number[] }
  | {
      type: 'signal';
      id: number;
      key: string;
      grid: FieldGrid;
      outline: Point[];
      walls: Float32Array;
      aps: Float32Array;
    };

/** A request without its id (the client numbers them). */
export type WorkerRequestBody = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id'>
    : never
  : never;

export type WorkerResponse =
  | { type: 'pong'; id: number; version: string }
  | { type: 'mesh'; id: number; key: string; mesh: FieldMesh; plan: FieldPlan }
  | { type: 'field'; id: number; key: string; grid: FieldGrid; field: Float32Array }
  | { type: 'error'; id: number; message: string };

export const WORKER_VERSION = '2';
/** Largest grid side, sensor count, barrier segments and rooms the worker accepts. */
export const MAX_FIELD_SIZE = 1024;
export const MAX_SENSORS = 256;
export const MAX_BARRIERS = 4096;
export const MAX_ROOMS = 512;

const validGrid = (g: FieldGrid | undefined): boolean =>
  !!g &&
  Number.isInteger(g.nx) &&
  Number.isInteger(g.ny) &&
  g.nx >= 1 &&
  g.ny >= 1 &&
  g.nx <= MAX_FIELD_SIZE &&
  g.ny <= MAX_FIELD_SIZE &&
  g.cell > 0 &&
  Number.isFinite(g.x0) &&
  Number.isFinite(g.y0);

/** A request handler with the current layout. Pure apart from that state, so it is unit tested. */
export function createHandler(): (req: WorkerRequest) => WorkerResponse {
  let current: { key: string; mesh: FieldMesh; plan: FieldPlan } | null = null;
  return (req) => {
    switch (req.type) {
      case 'ping':
        return { type: 'pong', id: req.id, version: WORKER_VERSION };
      case 'mesh': {
        if (!validGrid(req.grid))
          return {
            type: 'error',
            id: req.id,
            message: `grid must be 1..${MAX_FIELD_SIZE} cells a side`,
          };
        if (!Array.isArray(req.sensors) || req.sensors.length > MAX_SENSORS)
          return { type: 'error', id: req.id, message: `at most ${MAX_SENSORS} sensors` };
        const walls = Array.from(req.walls ?? []).slice(0, MAX_BARRIERS * 4);
        const rooms = (req.rooms ?? []).slice(0, MAX_ROOMS);
        const { mesh, plan } = planField(req.sensors, req.grid, req.outline ?? [], walls, rooms);
        current = { key: req.key, mesh, plan };
        return { type: 'mesh', id: req.id, key: req.key, mesh, plan };
      }
      case 'values': {
        if (!current || current.key !== req.key)
          return { type: 'error', id: req.id, message: 'unknown layout' };
        const n = current.mesh.members.reduce((s, m) => Math.max(s, ...m.map((i) => i + 1)), 0);
        if (req.values.length < n) return { type: 'error', id: req.id, message: 'too few values' };
        const field = fillField(current.plan, nodeValues(current.mesh, req.values));
        return { type: 'field', id: req.id, key: req.key, grid: current.plan.grid, field };
      }
      case 'signal': {
        if (!validGrid(req.grid))
          return {
            type: 'error',
            id: req.id,
            message: `grid must be 1..${MAX_FIELD_SIZE} cells a side`,
          };
        const input = {
          walls: Float32Array.from(req.walls ?? []).subarray(0, MAX_SIGNAL_SEGMENTS * SEG),
          aps: Float32Array.from(req.aps ?? []).subarray(0, MAX_SIGNAL_SOURCES * SRC),
        };
        const field = signalField(input, req.grid, req.outline ?? []);
        return { type: 'field', id: req.id, key: req.key, grid: req.grid, field };
      }
    }
  };
}
