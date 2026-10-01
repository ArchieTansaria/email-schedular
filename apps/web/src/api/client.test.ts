import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client.js';

afterEach(() => vi.unstubAllGlobals());

describe('frontend API client', () => {
  it('uses relative URLs and same-origin session credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.senders();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/senders',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it.each([400, 409, 413, 503, 500])(
    'maps HTTP %i errors into a stable ApiError',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ error: { code: `ERROR_${status}`, message: `Failure ${status}` } }),
              { status },
            ),
          ),
      );
      const error = await api.senders().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status,
        code: `ERROR_${status}`,
        message: `Failure ${status}`,
      });
    },
  );
});
