import { describe, expect, it, vi } from 'vitest';

import { FetchAiTransport } from './fetch-ai-transport.js';

describe('FetchAiTransport', () => {
  it('sends JSON without logging or returning request credentials', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'completed' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const transport = new FetchAiTransport(fetchImplementation);

    const result = await transport.send({
      method: 'POST',
      url: 'https://api.example.com/v1/responses',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: { model: 'writer' },
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.example.com/v1/responses',
      expect.objectContaining({ method: 'POST', body: '{"model":"writer"}' }),
    );
    expect(result).toEqual({
      status: 200,
      body: { status: 'completed' },
      headers: expect.any(Object),
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
