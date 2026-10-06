import { describe, expect, it, vi, afterEach } from 'vitest';
import { atomic, units, request, ApiError } from '../src/app/client';
import { terminal } from '../src/app/transactions';
afterEach(() => vi.unstubAllGlobals());
describe('wallet execution amounts', () => {
 it('preserves single-unit precision beyond the JavaScript safe integer limit', () => { expect(atomic('18446744073.709551615', 9)).toBe('18446744073709551615'); expect(units('18446744073709551615', 9)).toBe('18446744073.709551615'); });
 it('rejects precision loss and unsupported u64 values instead of rounding', () => { for (const value of ['0', '0.0000000001', '18446744073.709551616', '1e9', '-1', '01', 'NaN']) expect(() => atomic(value, 9)).toThrow(); });
 it('retains exact supply atomic units with variable base decimals', () => { expect(atomic('1000000000.000001', 6)).toBe('1000000000000001'); expect(units('1', 6)).toBe('0.000001'); });
 it('does not mistake confirmation for finalized execution', () => { expect(terminal('submitted')).toBe(false); expect(terminal('confirmed')).toBe(false); expect(terminal('finalized')).toBe(true); expect(terminal('expired')).toBe(true); });
});
describe('API failures', () => {
 it('preserves actionable API error codes without exposing response objects', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: 'conflict', message: 'Draft revision changed' } }) })); await expect(request('/models/id', {})).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'Draft revision changed' }); });
 it('reports an unavailable proxy response as a stable client error', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw Error('HTML'); } })); await expect(request('/tokens')).rejects.toBeInstanceOf(ApiError); });
});
