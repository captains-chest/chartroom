// Saves the example-plan fixture to a running Home Assistant as plan `example`, using the
// chartroom/plans/save websocket command (needs an admin token). Dev helper only.
// Run: HA_URL=http://127.0.0.1:8123 HA_TOKEN=... node scripts/example-plan/load-into-ha.mjs
import { readFileSync } from 'node:fs';

const url =
  (process.env.HA_URL ?? 'http://127.0.0.1:8123').replace(/^http/, 'ws') + '/api/websocket';
const token = process.env.HA_TOKEN;
if (!token) throw new Error('Set HA_TOKEN to a long-lived admin token.');
const plan = JSON.parse(readFileSync('frontend/test/fixtures/example-plan.json', 'utf8'));
const planId = process.env.PLAN_ID ?? 'example';

const ws = new WebSocket(url);
let id = 0;
const pending = new Map();
const call = (msg) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, ...msg }));
  });

ws.addEventListener('message', async (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
  else if (msg.type === 'auth_invalid') throw new Error(`auth failed: ${msg.message}`);
  else if (msg.type === 'auth_ok') {
    try {
      await call({ type: 'chartroom/plans/save', plan_id: planId, plan });
      const { plans } = await call({ type: 'chartroom/plans/list' });
      console.log(`saved plan '${planId}'; plans now:`, plans.map((p) => p.id).join(', '));
    } finally {
      ws.close();
    }
  } else if (msg.type === 'result') {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.success) p.resolve(msg.result);
    else p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
  }
});
