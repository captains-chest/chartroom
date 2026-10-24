import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CLIENT_ID,
  HA_URL,
  ensureChartroom,
  ensureDashboard,
  ensureExamplePlan,
  ensureFloorsAndAreas,
  onboard,
  waitForHa,
} from './ha';

const STATE = 'test-results/.auth/state.json';

export default async function globalSetup(): Promise<void> {
  await waitForHa();
  let token = process.env['HA_TOKEN'];
  let refresh: string | undefined;
  let expiresIn = 10 * 365 * 24 * 3600; // a long-lived token does not expire soon
  if (!token) {
    const tokens = await onboard(
      process.env['HA_USER'] ?? 'e2e',
      process.env['HA_PASSWORD'] ?? 'e2e-chartroom-ci',
    );
    if (!tokens) throw new Error('Home Assistant is already onboarded: set HA_TOKEN');
    token = tokens.access_token;
    refresh = tokens.refresh_token;
    expiresIn = tokens.expires_in;
  }
  process.env['HA_TOKEN'] = token;
  await ensureChartroom(token);
  await ensureDashboard(token);
  await ensureFloorsAndAreas(token);
  await ensureExamplePlan(
    token,
    JSON.parse(readFileSync('frontend/test/fixtures/example-plan.json', 'utf8')),
  );

  // The Home Assistant frontend reads its session from localStorage.hassTokens.
  const hassTokens = {
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    hassUrl: HA_URL,
    clientId: CLIENT_ID,
    expires: Date.now() + expiresIn * 1000,
    ...(refresh ? { refresh_token: refresh } : {}),
  };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(
    STATE,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: new URL(HA_URL).origin,
          localStorage: [{ name: 'hassTokens', value: JSON.stringify(hassTokens) }],
        },
      ],
    }),
  );
}
