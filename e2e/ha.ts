// Small Home Assistant client for test setup: onboarding, config flows, dashboards.

export const HA_URL = process.env['HA_URL'] ?? 'http://127.0.0.1:8123';
export const CLIENT_ID = `${HA_URL}/`;
export const DASHBOARD = 'chartroom-e2e';

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function waitForHa(timeoutMs = 180_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${HA_URL}/manifest.json`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`Home Assistant did not come up at ${HA_URL}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Onboard a fresh instance and return the owner's tokens. Returns null if already onboarded. */
export async function onboard(username: string, password: string): Promise<Tokens | null> {
  const steps = await json<{ step: string; done: boolean }[]>(
    await fetch(`${HA_URL}/api/onboarding`),
  );
  if (steps.find((s) => s.step === 'user')?.done) return null;
  const { auth_code } = await json<{ auth_code: string }>(
    await fetch(`${HA_URL}/api/onboarding/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        name: 'E2E',
        username,
        password,
        language: 'en',
      }),
    }),
  );
  const tokens = await json<Tokens>(
    await fetch(`${HA_URL}/auth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: auth_code,
        client_id: CLIENT_ID,
      }),
    }),
  );
  const auth = {
    Authorization: `Bearer ${tokens.access_token}`,
    'Content-Type': 'application/json',
  };
  for (const [path, body] of [
    ['core_config', {}],
    ['analytics', {}],
    ['integration', { client_id: CLIENT_ID, redirect_uri: `${HA_URL}/?auth_callback=1` }],
  ] as const) {
    await json(
      await fetch(`${HA_URL}/api/onboarding/${path}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body),
      }),
    );
  }
  return tokens;
}

export async function api<T>(token: string, path: string, body?: unknown): Promise<T> {
  return json<T>(
    await fetch(`${HA_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/** Add the Chartroom config entry unless it exists. */
export async function ensureChartroom(token: string): Promise<void> {
  const entries = await api<{ domain: string }[]>(
    token,
    '/api/config/config_entries/entry?domain=chartroom',
  );
  if (entries.length > 0) return;
  const flow = await api<{ flow_id: string; type: string }>(
    token,
    '/api/config/config_entries/flow',
    { handler: 'chartroom' },
  );
  const done = await api<{ type: string }>(
    token,
    `/api/config/config_entries/flow/${flow.flow_id}`,
    {},
  );
  if (done.type !== 'create_entry') throw new Error(`Chartroom flow ended with ${done.type}`);
}

/** Minimal websocket session: auth, then request/response by id. */
export async function withSocket<T>(
  token: string,
  fn: (send: <R>(msg: Record<string, unknown>) => Promise<R>) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(`${HA_URL.replace(/^http/, 'ws')}/api/websocket`);
  const pending = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
  let nextId = 1;
  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        type: string;
        id?: number;
        success?: boolean;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.type === 'auth_required')
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (msg.type === 'auth_ok') resolve();
      else if (msg.type === 'auth_invalid') reject(new Error('websocket auth failed'));
      else if (msg.type === 'result' && msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.success) p?.ok(msg.result);
        else p?.err(new Error(msg.error?.message ?? 'websocket error'));
      }
    });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
  });
  await ready;
  const send = <R>(msg: Record<string, unknown>): Promise<R> =>
    new Promise<R>((ok, err) => {
      const id = nextId++;
      pending.set(id, { ok: ok as (v: unknown) => void, err });
      ws.send(JSON.stringify({ ...msg, id }));
    });
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
}

/** A dedicated storage-mode dashboard with one Chartroom card (never touches the default one). */
export async function ensureDashboard(token: string): Promise<void> {
  await withSocket(token, async (send) => {
    const boards = await send<{ url_path: string }[]>({ type: 'lovelace/dashboards/list' });
    if (!boards.some((b) => b.url_path === DASHBOARD)) {
      await send({
        type: 'lovelace/dashboards/create',
        url_path: DASHBOARD,
        title: 'Chartroom test',
        mode: 'storage',
        show_in_sidebar: false,
        require_admin: false,
      });
    }
    await send({
      type: 'lovelace/config/save',
      url_path: DASHBOARD,
      config: {
        views: [
          {
            title: 'Chartroom',
            path: 'main',
            cards: [{ type: 'custom:chartroom-card', title: 'Chartroom' }],
          },
        ],
      },
    });
  });
}

export const FLOORS = [
  { floor_id: 'ground_floor', name: 'Ground floor', level: 0 },
  { floor_id: 'first_floor', name: 'First floor', level: 1 },
];
export const AREAS = [
  { area_id: 'living_room', name: 'Living room', floor: 'ground_floor' },
  { area_id: 'kitchen', name: 'Kitchen', floor: 'ground_floor' },
  { area_id: 'hall', name: 'Hall', floor: 'ground_floor' },
  { area_id: 'bedroom', name: 'Bedroom', floor: 'first_floor' },
  { area_id: 'office', name: 'Office', floor: 'first_floor' },
  { area_id: 'bath', name: 'Bath', floor: 'first_floor' },
];

/**
 * Floors and areas the tests link rooms to. Existing ones (on a developer's instance) are left
 * as they are, except that an area without a floor gets one; only missing ids are created, which
 * on a fresh instance gives these ids.
 */
export async function ensureFloorsAndAreas(token: string): Promise<void> {
  await withSocket(token, async (send) => {
    const floors = await send<{ floor_id: string }[]>({ type: 'config/floor_registry/list' });
    for (const f of FLOORS) {
      if (floors.some((x) => x.floor_id === f.floor_id)) continue;
      await send({ type: 'config/floor_registry/create', name: f.name, level: f.level });
    }
    const areas = await send<{ area_id: string; floor_id: string | null }[]>({
      type: 'config/area_registry/list',
    });
    for (const a of AREAS) {
      const found = areas.find((x) => x.area_id === a.area_id);
      // Onboarding creates some of these areas without a floor: put them on theirs.
      if (found && !found.floor_id)
        await send({ type: 'config/area_registry/update', area_id: a.area_id, floor_id: a.floor });
      if (found) continue;
      await send({ type: 'config/area_registry/create', name: a.name, floor_id: a.floor });
    }
  });
}

/** Test sensors (from .ci/configuration.yaml) and the areas they belong in. */
export const SENSOR_AREAS: Record<string, string> = {
  'sensor.kitchen_temperature': 'kitchen',
  'sensor.kitchen_humidity': 'kitchen',
  'sensor.bedroom_temperature': 'bedroom',
  'sensor.hall_sensor_rssi': 'hall',
};

/** Wait until Home Assistant has finished starting (integrations such as template are set up). */
export async function waitForRunning(token: string, timeoutMs = 120_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while ((await api<{ state?: string }>(token, '/api/config')).state !== 'RUNNING') {
    if (Date.now() > end) throw new Error('Home Assistant did not finish starting');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Put the test sensors in their areas, only where an entity exists and has no area yet. In CI the
 * sensors come from .ci/configuration.yaml, so wait for them to be registered.
 */
export async function ensureSensorAreas(token: string, timeoutMs = 60_000): Promise<void> {
  await waitForRunning(token);
  const end = Date.now() + timeoutMs;
  await withSocket(token, async (send) => {
    const list = (): Promise<{ entity_id: string; area_id: string | null }[]> =>
      send({ type: 'config/entity_registry/list' });
    let entities = await list();
    const missing = (): string[] =>
      Object.keys(SENSOR_AREAS).filter((id) => !entities.some((e) => e.entity_id === id));
    while (process.env['CI'] && missing().length > 0) {
      if (Date.now() > end) throw new Error(`test sensors missing: ${missing().join(', ')}`);
      await new Promise((r) => setTimeout(r, 1000));
      entities = await list();
    }
    for (const [entity_id, area_id] of Object.entries(SENSOR_AREAS)) {
      const e = entities.find((x) => x.entity_id === entity_id);
      if (!e || e.area_id) continue;
      await send({ type: 'config/entity_registry/update', entity_id, area_id });
    }
  });
}

export const planCommand = <R>(
  token: string,
  msg: { type: string; plan_id?: string; plan?: unknown },
): Promise<R> => withSocket(token, (send) => send<R>(msg));

export const getPlan = <R = Record<string, unknown>>(token: string, plan_id: string): Promise<R> =>
  planCommand<R>(token, { type: 'chartroom/plans/get', plan_id });

export const savePlan = (token: string, plan_id: string, plan: unknown): Promise<unknown> =>
  planCommand(token, { type: 'chartroom/plans/save', plan_id, plan });

/** Delete a plan the tests made; a plan that is already gone is fine. */
export async function deletePlan(token: string, plan_id: string): Promise<void> {
  try {
    await planCommand(token, { type: 'chartroom/plans/delete', plan_id });
  } catch (err) {
    if (!/not found/i.test((err as Error).message)) throw err;
  }
}

/** The traced example plan as plan 'example', unless one is already stored. */
export async function ensureExamplePlan(token: string, plan: unknown): Promise<void> {
  const { plans } = await planCommand<{ plans: { id: string }[] }>(token, {
    type: 'chartroom/plans/list',
  });
  if (!plans.some((p) => p.id === 'example')) await savePlan(token, 'example', plan);
}
