// Messages between the main thread and the field worker. The worker triangulates the sensor
// layout once per change ('mesh') and then turns sensor values into a field grid ('values').
import {
  buildMesh,
  fillField,
  nodeValues,
  planField,
  type FieldGrid,
  type FieldMesh,
  type FieldPlan,
} from './field';
import type { Point } from './plan';

export type WorkerRequest =
  | { type: 'ping'; id: number }
  | { type: 'mesh'; id: number; key: string; sensors: Point[]; outline: Point[]; grid: FieldGrid }
  | { type: 'values'; id: number; key: string; values: number[] };

/** A request without its id (the client numbers them). */
export type WorkerRequestBody = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id'>
    : never
  : never;

export type WorkerResponse =
  | { type: 'pong'; id: number; version: string }
  | { type: 'mesh'; id: number; key: string; mesh: FieldMesh }
  | { type: 'field'; id: number; key: string; grid: FieldGrid; field: Float32Array }
  | { type: 'error'; id: number; message: string };

export const WORKER_VERSION = '1';
/** Largest grid side and sensor count the worker accepts. */
export const MAX_FIELD_SIZE = 1024;
export const MAX_SENSORS = 2000;

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
        const mesh = buildMesh(req.sensors);
        current = { key: req.key, mesh, plan: planField(mesh, req.grid, req.outline ?? []) };
        return { type: 'mesh', id: req.id, key: req.key, mesh };
      }
      case 'values': {
        if (!current || current.key !== req.key)
          return { type: 'error', id: req.id, message: 'unknown layout' };
        const n = current.mesh.members.reduce((s, m) => Math.max(s, ...m.map((i) => i + 1)), 0);
        if (req.values.length < n) return { type: 'error', id: req.id, message: 'too few values' };
        const field = fillField(current.plan, nodeValues(current.mesh, req.values));
        return { type: 'field', id: req.id, key: req.key, grid: current.plan.grid, field };
      }
    }
  };
}
