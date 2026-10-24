// The editor's type aliases. Its interfaces are in models.ts.
import type { Plan } from '../plan/models';
import type { Point } from '../plan/types';
import type { Items } from './models';

export type Tool =
  | 'select'
  | 'wall'
  | 'room'
  | 'door'
  | 'window'
  | 'source'
  | 'device'
  | 'measure'
  | 'underlay';

export type Kind = keyof Items;
export type Item = Items[Kind];

export type Drag =
  | {
      readonly type: 'item';
      readonly base: Plan;
      readonly kind: Kind;
      readonly item: Item;
      readonly start: Point;
    }
  | { readonly type: 'endpoint'; readonly base: Plan; readonly from: Point }
  | { readonly type: 'vertex'; readonly base: Plan; readonly id: string; readonly index: number }
  | { readonly type: 'underlay'; readonly base: Plan; readonly start: Point };
