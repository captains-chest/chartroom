// The selected item's panel: its kind's fields (one module per kind), under its title and above
// a Delete button. A new kind of item adds its fields module and one line here.
import { button } from '../../ui';
import { findItem, titleOf } from '../kinds';
import type { Items, Selection } from '../models';
import type { Item, Kind } from '../types';
import { type Fields, type PanelContext, section } from './context';
import { deviceFields } from './device';
import { openingFields } from './opening';
import { roomFields } from './room';
import { sourceFields } from './source';
import { wallFields } from './wall';

const FIELDS: { readonly [K in Kind]: (ctx: PanelContext, item: Items[K]) => Fields } = {
  wall: wallFields,
  room: roomFields,
  door: openingFields,
  window: openingFields,
  source: sourceFields,
  device: deviceFields,
};

/** The panel of the item `sel` picks, or null when the plan has no such item. */
export function itemPanel(
  ctx: PanelContext,
  sel: Selection,
  remove: () => void,
): HTMLElement | null {
  const item = findItem(ctx.plan, sel);
  if (!item) return null;
  const label = titleOf(sel.kind);
  return section(
    label,
    sel.kind,
    ...(FIELDS[sel.kind] as (ctx: PanelContext, item: Item) => Fields)(ctx, item),
    button(`Delete ${label.toLowerCase()}`, remove, { class: 'danger', 'data-action': 'delete' }),
  );
}
