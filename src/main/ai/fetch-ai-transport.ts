import type { AiHttpRequest, AiHttpResponse, AiHttpTransport } from './ai-variant-generator.js';

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export class FetchAiTransport implements AiHttpTransport {
  constructor(private readonly fetchImplementation: FetchImplementation = fetch) {}

  async send(request: AiHttpRequest): Promise<AiHttpResponse> {
    const response = await this.fetchImplementation(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body: unknown = contentType.toLowerCase().includes('application/json')
      ? await response.json()
      : await response.text();
    return {
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }
}
