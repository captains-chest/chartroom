import type { WorkerRequestBody, WorkerResponse } from '../worker-protocol';

export type HeatLayerId = 'temperature' | 'humidity' | 'signal';

/** Colour stops: position 0..1 and sRGB. */
export type RampStop = readonly [number, number, number, number];

export type RendererKind = 'webgl2' | 'canvas';

/** Sends one request to the field worker (or its in-thread stand-in). */
export type FieldRequest = (req: WorkerRequestBody) => Promise<WorkerResponse>;
