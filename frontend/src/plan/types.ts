// The plan's type aliases. Its interfaces are in models.ts.
import type { Opening } from './models';

/** A point in plan space, in metres. */
export type Point = readonly [x: number, y: number];

/** A window is an opening without a hinge or swing. */
export type Window = Opening;

/** What a signal source is. Sensors were sources too before schema version 2. */
export type SourceKind = 'access_point' | 'radio';

export type OpeningKind = 'door' | 'window';
