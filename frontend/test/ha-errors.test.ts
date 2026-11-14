import { describe, expect, it } from 'vite-plus/test';
import { errorText, retryable } from '../src/ha-errors';

describe('request errors', () => {
  it("retries everything but Home Assistant's final answers", () => {
    expect(retryable(new Error('timeout'))).toBe(true);
    expect(retryable({ type: 'result', success: false, error: { code: 3, message: 'x' } })).toBe(
      true,
    );
    expect(retryable({ code: 'not_loaded', message: 'Chartroom is not set up' })).toBe(true);
    expect(retryable({ code: 'unknown_error', message: 'boom' })).toBe(true);
    expect(retryable(undefined)).toBe(true);
    for (const code of ['invalid_format', 'unauthorized', 'unknown_command', 'not_found'])
      expect(retryable({ code, message: 'no' })).toBe(false);
  });

  it('reads the text of an error, a Home Assistant answer, or a lost connection', () => {
    expect(errorText(new Error('timeout'))).toBe('timeout');
    expect(errorText({ code: 'invalid_format', message: 'bad plan' })).toBe('bad plan');
    expect(errorText({ error: { code: 3, message: 'Connection lost' } })).toBe('Connection lost');
    expect(errorText('odd')).toBe('odd');
  });
});
