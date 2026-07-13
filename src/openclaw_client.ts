/**
 * OpenClaw Gateway client — sends prompts via /v1/chat/completions with
 * per-document session routing for full conversation context.
 *
 * Each document gets its own OpenClaw session, keyed by the doc ID.
 * The @clear command increments a counter to start a fresh session
 * (e.g. <docId>, <docId>-2, <docId>-3, etc.) — old sessions age out
 * automatically via OpenClaw maintenance.
 *
 * Requires: gateway.http.endpoints.chatCompletions.enabled: true
 */
import type { AppConfig, Logger, ResponseChunk } from './types.js';

export class OpenClawClient {
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string;
  private readonly model: string;
  private readonly log: Logger;
  private readonly timeoutMs = 120_000;

  /** Maps docId → current session key (docId, docId-2, docId-3, etc.) */
  private sessionKeys = new Map<string, string>();
  /** Maps docId → clear counter */
  private clearCounters = new Map<string, number>();

  constructor(config: AppConfig, log: Logger) {
    this.gatewayUrl = config.openclaw.gateway_url.replace(/\/$/, '');
    this.gatewayToken = config.openclaw.gateway_token;
    this.model = config.openclaw.model || 'openclaw';
    this.log = log;
  }

  /** Get the current session key for a doc (creates one if none exists) */
  getSessionKey(docId: string): string {
    let key = this.sessionKeys.get(docId);
    if (!key) {
      const counter = this.clearCounters.get(docId) ?? 0;
      key = counter === 0 ? docId : `${docId}-${counter}`;
      this.sessionKeys.set(docId, key);
    }
    return key;
  }

  /** Clear the session for a doc — next prompt will start a fresh session */
  clearSession(docId: string): string {
    const counter = (this.clearCounters.get(docId) ?? 0) + 1;
    this.clearCounters.set(docId, counter);
    const newKey = `${docId}-${counter}`;
    this.sessionKeys.set(docId, newKey);
    this.log.info(`Cleared session for doc ${docId} → new session key: ${newKey}`);
    return newKey;
  }

  /** Build request headers with auth + session routing */
  private buildHeaders(sessionKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': 'main',
      'x-openclaw-session-key': sessionKey,
    };

    if (this.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.gatewayToken}`;
    }

    return headers;
  }

  /**
   * Send a prompt to the OpenClaw Gateway via /v1/chat/completions.
   * Uses the doc ID as the session key for conversation continuity.
   *
   * Yields ResponseChunk objects as chunks arrive.
   */
  async *sendPrompt(docId: string, prompt: string): AsyncGenerator<ResponseChunk> {
    const sessionKey = this.getSessionKey(docId);
    const url = `${this.gatewayUrl}/v1/chat/completions`;
    const headers = this.buildHeaders(sessionKey);

    // OpenAI Chat Completions format
    const body = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
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
        yield* this.sendPrompt(docId, prompt);
        return;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gateway returned ${res.status}: ${text}`);
      }

      const contentType = res.headers.get('Content-Type') ?? '';

      if (contentType.includes('text/event-stream')) {
        yield* this.parseChatCompletionsSSE(res);
      } else {
        // Non-streaming fallback
        const data = await res.json() as ChatCompletionsResponse;
        const text = data.choices?.[0]?.message?.content ?? '';
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
   * Parse an OpenAI Chat Completions SSE stream.
   *
   * Chunks have: choices[0].delta.content (text deltas)
   * Stream ends with: data: [DONE]
   */
  private async *parseChatCompletionsSSE(res: Response): AsyncGenerator<ResponseChunk> {
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

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              yield { text: '', done: true };
              return;
            }

            try {
              const parsed = JSON.parse(data) as ChatCompletionsChunk;
              const delta = parsed.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                yield { text: delta, done: false };
              }
              // Check for finish_reason
              const finishReason = parsed.choices?.[0]?.finish_reason;
              if (finishReason === 'stop' || finishReason === 'length') {
                yield { text: '', done: true };
                return;
              }
            } catch {
              // Non-JSON data line — skip
              this.log.debug('Unparseable SSE data line:', data);
            }
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

/** Non-streaming Chat Completions response */
interface ChatCompletionsResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

/** Streaming Chat Completions chunk */
interface ChatCompletionsChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}