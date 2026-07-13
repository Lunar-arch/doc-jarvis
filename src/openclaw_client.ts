/**
 * OpenClaw Gateway client — sends prompts and receives streamed responses.
 *
 * Uses the OpenResponses-compatible `/v1/responses` endpoint (must be enabled
 * in OpenClaw config via `gateway.http.endpoints.responses.enabled: true`).
 *
 * Supports both SSE streaming and non-streaming (fallback) responses.
 * Handles: gateway down, rate limits (429), timeouts, and retry logic.
 *
 * @see https://github.com/openclaw/openclaw — OpenClaw documentation
 */
import type { AppConfig, Logger, ResponseChunk } from './types.js';

export class OpenClawClient {
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string;
  private readonly sessionKey: string;
  private readonly model: string;
  private readonly log: Logger;
  private readonly timeoutMs = 60_000;

  constructor(config: AppConfig, log: Logger) {
    this.gatewayUrl = config.openclaw.gateway_url.replace(/\/$/, '');
    this.gatewayToken = config.openclaw.gateway_token;
    this.sessionKey = config.openclaw.session_key;
    this.model = config.openclaw.model || 'openclaw';
    this.log = log;
  }

  /** Build request headers with auth + session routing */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': 'main',
    };

    if (this.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.gatewayToken}`;
    }

    if (this.sessionKey) {
      headers['x-openclaw-session-key'] = this.sessionKey;
    }

    return headers;
  }

  /**
   * Send a prompt to the OpenClaw Gateway via the /v1/responses endpoint.
   *
   * Yields ResponseChunk objects as chunks arrive. Falls back to non-streaming
   * if SSE is not supported.
   */
  async *sendPrompt(prompt: string): AsyncGenerator<ResponseChunk> {
    const url = `${this.gatewayUrl}/v1/responses`;
    const headers = this.buildHeaders();

    // OpenResponses-compatible request body
    const body = JSON.stringify({
      model: this.model,
      input: prompt,
      stream: true,
      ...(this.sessionKey ? { user: this.sessionKey } : {}),
    });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        this.log.warn(`Rate limited (429) — waiting ${wait}ms before retry`);
        await sleep(wait);
        yield* this.sendPrompt(prompt);
        return;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gateway returned ${res.status}: ${text}`);
      }

      const contentType = res.headers.get('Content-Type') ?? '';

      if (contentType.includes('text/event-stream')) {
        // OpenResponses SSE streaming
        yield* this.parseOpenResponsesSSE(res);
      } else {
        // Non-streaming fallback — OpenResponses ResponseResource
        const data = await res.json() as OpenResponsesResponse;
        const text = extractResponseText(data);
        yield { text, done: true };
      }
    } catch (err) {
      if (err instanceof TypeError) {
        this.log.error('Gateway is unreachable:', err.message);
      }
      throw err;
    }
  }

  /**
   * Parse an OpenResponses SSE stream into ResponseChunks.
   *
   * Event types emitted by the Gateway:
   *   response.created, response.in_progress, response.output_item.added,
   *   response.content_part.added, response.output_text.delta,
   *   response.output_text.done, response.content_part.done,
   *   response.output_item.done, response.completed, response.failed
   *
   * Text deltas arrive in `response.output_text.delta` events (field: `delta`).
   * The stream terminates with `data: [DONE]`.
   */
  private async *parseOpenResponsesSSE(res: Response): AsyncGenerator<ResponseChunk> {
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by \n\n)
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          const lines = event.split('\n');
          // SSE events may have an `event:` line (event type) and `data:` line (payload)
          let eventType = '';
          let dataLine = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              dataLine = line.slice(6).trim();
            }
          }

          if (!dataLine) continue;
          if (dataLine === '[DONE]') {
            return;
          }

          try {
            const parsed = JSON.parse(dataLine) as OpenResponsesSSEEvent;

            // Text deltas arrive in response.output_text.delta events
            if (eventType === 'response.output_text.delta' || parsed.type === 'response.output_text.delta') {
              const delta = (parsed as { delta?: string }).delta ?? '';
              if (delta) {
                yield { text: delta, done: false };
              }
            } else if (eventType === 'response.completed' || parsed.type === 'response.completed') {
              yield { text: '', done: true };
              return;
            } else if (eventType === 'response.failed' || parsed.type === 'response.failed') {
              const errorMsg = (parsed as { error?: { message?: string } }).error?.message ?? 'Unknown error';
              throw new Error(`OpenClaw response failed: ${errorMsg}`);
            }
          } catch (err) {
            // If it's our own throw, re-throw
            if (err instanceof Error && err.message.startsWith('OpenClaw response failed')) {
              throw err;
            }
            // Non-JSON data line — skip
            this.log.debug('Unparseable SSE data line:', dataLine);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { text: '', done: true };
  }

  /** Check if the gateway is reachable (uses /healthz liveness probe) */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.gatewayUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * OpenResponses non-streaming response (ResponseResource).
 * The output array contains items with content parts that hold the text.
 */
interface OpenResponsesResponse {
  id?: string;
  model?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  output_text?: string;
}

/** SSE event from the OpenResponses stream */
interface OpenResponsesSSEEvent {
  type?: string;
  delta?: string;
  error?: { message?: string };
}

/** Extract text from a non-streaming OpenResponses ResponseResource */
function extractResponseText(data: OpenResponsesResponse): string {
  // Some responses include a top-level output_text field
  if (data.output_text) return data.output_text;

  // Otherwise, collect text from output[].content[].text
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}