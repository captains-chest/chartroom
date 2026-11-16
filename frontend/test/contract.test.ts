// Rules the integration holds too: tests/fixtures/contract.json, also read by tests/test_contract.py.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { PLAN_ID_PATTERN, PLAN_SCHEMA_VERSION } from '../src/plan/constants';
import { imageTypeOfName, looksLike, underlayFileName } from '../src/plan-file';
import { MAX_BYTES, UNDERLAY_TYPES } from '../src/underlay';
import { underlayPlanId } from '../src/underlay-url';

interface Contract {
  plan_ids: { valid: string[]; invalid: string[] };
  underlay_urls: { valid: { url: string; plan_id: string }[]; invalid: string[] };
  image_types: Record<string, string>;
  image_heads: { type: string; hex?: string; text?: string; ok: boolean }[];
  underlay_max_bytes: number;
  plan_schema_version: number;
}

const CONTRACT = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contract.json', import.meta.url), 'utf8'),
) as Contract;

const bytes = (c: { hex?: string; text?: string }): Uint8Array =>
  c.text !== undefined
    ? new TextEncoder().encode(c.text)
    : Uint8Array.from(c.hex!.match(/../g)!.map((b) => parseInt(b, 16)));

describe('the contract with the integration', () => {
  it('accepts and refuses the same plan ids', () => {
    for (const id of CONTRACT.plan_ids.valid) expect(PLAN_ID_PATTERN.test(id), id).toBe(true);
    for (const id of CONTRACT.plan_ids.invalid)
      expect(PLAN_ID_PATTERN.test(id), JSON.stringify(id)).toBe(false);
  });

  it('takes the same underlay URLs as a plan’s own image', () => {
    for (const { url, plan_id } of CONTRACT.underlay_urls.valid)
      expect(underlayPlanId(url), url).toBe(plan_id);
    for (const url of CONTRACT.underlay_urls.invalid)
      expect(underlayPlanId(url), JSON.stringify(url)).toBeNull();
  });

  it('has the same image types, file extensions, size limit and schema version', () => {
    for (const [type, ext] of Object.entries(CONTRACT.image_types)) {
      expect(UNDERLAY_TYPES.test(type), type).toBe(true);
      expect(underlayFileName('p', type)).toBe(`chartroom-p.${ext}`);
      expect(imageTypeOfName(`x.${ext}`)).toBe(type);
    }
    expect(UNDERLAY_TYPES.test('image/gif')).toBe(false);
    expect(MAX_BYTES).toBe(CONTRACT.underlay_max_bytes);
    expect(PLAN_SCHEMA_VERSION).toBe(CONTRACT.plan_schema_version);
  });

  it('checks image signatures as the upload does', () => {
    for (const c of CONTRACT.image_heads)
      expect(looksLike(c.type, bytes(c)), JSON.stringify(c)).toBe(c.ok);
  });
});
