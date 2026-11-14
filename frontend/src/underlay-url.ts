// Where a plan's underlay image lives, and the check that a stored URL is that and nothing else.
// Kept apart from underlay.ts so the plan loader (and the card) need not pull in the image code.
import { PLAN_ID_PATTERN } from './plan/constants';
import type { Plan } from './plan/models';

export const underlayPath = (planId: string): string =>
  `/api/chartroom/underlay/${encodeURIComponent(planId)}`;

/**
 * The plan whose stored image `url` is (as the upload returns it: the path, maybe `?v=<hash>`), or
 * null for any other URL. The image is fetched with the user's token, so a plan must not point it
 * anywhere else (UNDERLAY_URL_RE in const.py holds the same rule).
 */
export function underlayPlanId(url: string): string | null {
  const prefix = underlayPath('');
  const m =
    typeof url === 'string' &&
    url.startsWith(prefix) &&
    /^([^/?#]+)(\?v=[0-9a-f]{1,64})?$/.exec(url.slice(prefix.length));
  return m && PLAN_ID_PATTERN.test(m[1]!) ? m[1]! : null;
}

/**
 * The plan, without its underlay when that is not the plan's own image: a plan stored before the
 * integration checked the URL still loads, shows without the drawing, and saves again.
 * `underlayIgnored` says one was dropped, so an admin can be told to import the image again.
 */
export function ownUnderlayOnly<P extends Plan>(
  planId: string,
  plan: P,
): { plan: P; underlayIgnored: boolean } {
  const ignored = plan.underlay != null && underlayPlanId(plan.underlay.url) !== planId;
  return { plan: ignored ? { ...plan, underlay: null } : plan, underlayIgnored: ignored };
}
