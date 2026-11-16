// The selected wall: material, thickness, length.
import { add, frame, roundToMm } from '../../geometry';
import type { Wall } from '../../plan/models';
import { moveEndpoint, updateWall } from '../../plan/ops';
import { field, h, numberInput, select } from '../../ui';
import { type Fields, materialOptions, type PanelContext } from './context';

export function wallFields(ctx: PanelContext, wall: Wall): Fields {
  const { id } = wall;
  const length = frame(wall).length;
  return [
    field(
      'Material',
      select(
        materialOptions(ctx.plan),
        wall.material,
        (v) => ctx.commit(updateWall(ctx.plan, id, { material: v })),
        {
          name: 'material',
        },
      ),
    ),
    field(
      'Thickness (cm)',
      numberInput(
        roundToMm(wall.thickness * 100),
        (v) => ctx.commit(updateWall(ctx.plan, id, { thickness: v / 100 })),
        { name: 'thickness', min: 1, max: 100, step: 0.5 },
      ),
    ),
    field(
      'Length (m)',
      numberInput(
        roundToMm(length),
        (v) => {
          if (v <= 0.05) return;
          const { u } = frame(wall);
          ctx.commit(moveEndpoint(ctx.plan, wall.b, add(wall.a, [u[0] * v, u[1] * v])));
        },
        { name: 'length', min: 0.05, step: 0.01 },
      ),
    ),
    h('p', { class: 'meta' }, `${wall.id}`),
  ];
}
