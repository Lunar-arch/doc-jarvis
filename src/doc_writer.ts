/**
 * Doc writer — inserts streamed OpenClaw response text into a Google Doc.
 *
 * When a prompt is sent to OpenClaw:
 * 1. Inserts " 👀" right after the prompt text (with a space if needed)
 *    The eyes are NEVER removed — they serve as a permanent marker that this
 *    prompt has been seen, so the scanner skips it on future polls.
 * 2. When the first chunk arrives, inserts "\n\nJarvis: " + response BELOW the eyes
 * 3. Streams subsequent chunks as they arrive at ~stream_interval_ms increments
 */
import type { AppConfig, Logger, PromptBlock, ResponseChunk } from './types.js';
import { DocsClient } from './docs.js';

export class DocWriter {
  private readonly docsClient: DocsClient;
  private readonly streamIntervalMs: number;
  private readonly log: Logger;

  constructor(docsClient: DocsClient, config: AppConfig, log: Logger) {
    this.docsClient = docsClient;
    this.streamIntervalMs = config.stream_interval_ms;
    this.log = log;
  }

  async writeResponse(prompt: PromptBlock, chunks: AsyncGenerator<ResponseChunk>): Promise<void> {
    const insertIndex = prompt.endIndex;

    // Step 1: Insert " 👀" right after the prompt text (NEVER removed)
    const text = prompt.promptText;
    const needsSpace = text.length > 0 && !text.endsWith(' ');
    const eyesText = needsSpace ? ' \uD83D\uDC40' : '\uD83D\uDC40'; // 👀 = U+1F440
    await this.docsClient.insertText(prompt.docId, eyesText, insertIndex);

    // Response goes right after the eyes
    const responseStart = insertIndex + eyesText.length;

    try {
      let firstChunk = true;
      let responseIdx = 0;

      // Buffer chunks and flush every 1 second instead of writing each chunk individually.
      // This batches all text that arrived during the interval into a single API call.
      const flushIntervalMs = 1000;
      let buffer = '';
      let flushTimer: Promise<void> | null = null;

      for await (const chunk of chunks) {
        if (chunk.text.length === 0 && !chunk.done) continue;

        if (firstChunk) {
          // Insert "\n\nJarvis: " + first chunk after the eyes
          const responsePrefix = '\n\nJarvis: ';
          const textToInsert = responsePrefix + chunk.text;
          await this.docsClient.insertText(prompt.docId, textToInsert, responseStart);
          responseIdx = responseStart + textToInsert.length;
          firstChunk = false;

          // Start the flush timer for subsequent chunks
          flushTimer = startFlushTimer();
        } else if (chunk.text.length > 0) {
          // Accumulate text into buffer — it'll be flushed by the timer
          buffer += chunk.text;
        }

        if (chunk.done && buffer.length > 0) {
          // Final flush for any remaining buffered text
          if (flushTimer) await flushTimer;
          await this.flushBuffer(prompt.docId, buffer, responseIdx);
          responseIdx += buffer.length;
          buffer = '';
        }
      }

      // Wait for any pending flush before finishing
      if (flushTimer) await flushTimer;
      if (buffer.length > 0) {
        await this.flushBuffer(prompt.docId, buffer, responseIdx);
        responseIdx += buffer.length;
        buffer = '';
      }

      // Handle empty response
      if (firstChunk) {
        await this.docsClient.insertText(prompt.docId, '\n\nJarvis: (no response received)', responseStart);
      }

      this.log.info(`Finished writing response in doc ${prompt.docId}`);
    } catch (err) {
      this.log.error(`DocWriter error:`, err);
      throw err;
    }
  }

  /** Flush the buffered text to the doc in a single API call */
  private async flushBuffer(docId: string, text: string, index: number): Promise<void> {
    if (text.length === 0) return;
    await this.docsClient.insertText(docId, text, index);
  }
}

/** Start a 1-second timer that resolves when it elapses */
function startFlushTimer(): Promise<void> {
  return sleep(1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}