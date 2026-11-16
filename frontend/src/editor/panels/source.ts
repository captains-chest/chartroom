// A new source's kind (the Source tool), and the selected source: kind, entity, level at 1 m.
import { sourceChoices, entityArea } from '../../model';
import type { Source } from '../../plan/models';
import { updateSource } from '../../plan/ops';
import type { SourceKind } from '../../plan/types';
import { field, h, numberInput, select, textInput } from '../../ui';
import { areaName } from '../rooms';
import { type Fields, type PanelContext, section } from './context';

export const SOURCE_KINDS: { value: SourceKind; label: string }[] = [
  { value: 'sensor', label: 'Temperature / humidity sensor' },
  { value: 'access_point', label: 'Wi-Fi access point' },
  { value: 'radio', label: 'Radio (Zigbee, Z-Wave, Thread…)' },
];

export function newSourcePanel(kind: SourceKind, pick: (kind: SourceKind) => void): HTMLElement {
  return section(
    'New source',
    'new-source',
    field(
      'Kind',
      select(SOURCE_KINDS, kind, (v) => pick(v as SourceKind), {
        name: 'source-kind',
      }),
    ),
    h('p', { class: 'hint' }, 'Click on the plan to place it, then drag it into position.'),
  );
}

export function sourceFields(ctx: PanelContext, src: Source): Fields {
  const { id } = src;
  const hass = ctx.hass;
  const floor = ctx.plan.floor_id ?? null;
  const set = (patch: Parameters<typeof updateSource>[2]): void =>
    ctx.commit(updateSource(ctx.plan, id, patch));
  const pick = (v: string): void => {
    const entity = v.trim();
    set({ entity_id: entity, area_id: entity ? entityArea(hass, entity) : null });
  };
  const choices = sourceChoices(hass, src.kind, floor);
  const inArea = src.area_id ? areaName(hass, src.area_id) : null;
  let entityControl: HTMLElement;
  if (src.kind === 'sensor') {
    const opts = choices.map((c) => ({ value: c.entity_id, label: c.name }));
    if (src.entity_id && !opts.some((o) => o.value === src.entity_id))
      opts.unshift({ value: src.entity_id, label: `${src.entity_id} (not on this floor)` });
    entityControl = select(
      [
        { value: '', label: opts.length ? '— pick a sensor —' : '— no sensors on this floor —' },
        ...opts,
      ],
      src.entity_id,
      pick,
      { name: 'entity' },
    );
  } else {
    const list = h('datalist', { id: `entities-${id}` });
    for (const c of choices) list.append(h('option', { value: c.entity_id }, c.name));
    entityControl = h(
      'div',
      { class: 'combo' },
      textInput(src.entity_id, pick, {
        name: 'entity',
        list: `entities-${id}`,
        placeholder: 'sensor.…_rssi, device_tracker.…',
      }),
      list,
    );
  }
  return [
    field(
      'Kind',
      select(SOURCE_KINDS, src.kind, (v) => set({ kind: v as SourceKind }), {
        name: 'source-kind',
      }),
    ),
    field(src.kind === 'sensor' ? 'Sensor' : 'Entity', entityControl),
    src.kind === 'sensor'
      ? null
      : field(
          'Level at 1 m (dBm)',
          numberInput(src.tx_dbm ?? -40, (v) => set({ tx_dbm: v }), {
            name: 'tx-dbm',
            min: -120,
            max: 30,
            step: 1,
          }),
        ),
    h(
      'p',
      { class: 'meta', 'data-area': src.area_id ?? '' },
      `${inArea ? `In ${inArea}` : 'No area'} · ${src.position[0].toFixed(2)}, ${src.position[1].toFixed(2)} m`,
    ),
  ];
}
