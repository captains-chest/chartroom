// The selected door or window: width, material, thickness, its open/closed sensor, a door's hinge
// and swing.
import { roundToMm } from '../../geometry';
import type { Door } from '../../plan/models';
import { updateOpening } from '../../plan/ops';
import type { Window } from '../../plan/types';
import { button, field, h, numberInput, select, textInput } from '../../ui';
import { type Fields, materialOptions, type PanelContext } from './context';

export function openingFields(ctx: PanelContext, o: Door | Window): Fields {
  const { id } = o;
  const isDoor = 'hinge' in o;
  const set = (patch: Partial<Omit<Door, 'id' | 'wall'>>): void =>
    ctx.commit(updateOpening(ctx.plan, id, patch));
  return [
    field(
      'Width (cm)',
      numberInput(roundToMm(o.width * 100), (v) => set({ width: v / 100 }), {
        name: 'width',
        min: 10,
        step: 1,
      }),
    ),
    field(
      'Material',
      select(materialOptions(ctx.plan), o.material, (v) => set({ material: v }), {
        name: 'material',
      }),
    ),
    field(
      'Thickness (cm)',
      numberInput(roundToMm(o.thickness * 100), (v) => set({ thickness: v / 100 }), {
        name: 'thickness',
        min: 0.1,
        step: 0.1,
      }),
    ),
    field(
      isDoor ? 'Sensor (optional)' : 'Sensor (optional)',
      textInput(o.entity_id ?? '', (v) => set({ entity_id: v.trim() || undefined }), {
        name: 'entity_id',
        placeholder: 'binary_sensor.…',
      }),
    ),
    isDoor
      ? h(
          'div',
          { class: 'row' },
          button('Flip hinge', () => set({ hinge: (o as Door).hinge === 'a' ? 'b' : 'a' }), {
            'data-action': 'flip-hinge',
          }),
          button('Flip swing', () => set({ swing: (o as Door).swing === 1 ? -1 : 1 }), {
            'data-action': 'flip-swing',
          }),
        )
      : null,
  ];
}
