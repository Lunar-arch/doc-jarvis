/**
 * Prompt scanner — searches doc content for the trigger keyword and extracts prompt blocks.
 *
 * A prompt block starts with the trigger token (e.g. `@jarvis`) and ends at:
 * - A blank line (double newline `\n\n`)
 * - Or an explicit end delimiter if configured
 *
 * Matching is case-insensitive — `@Jarvis`, `@JARVIS`, `@jarvis` all match.
 * If a prompt already has the 👀 eyes marker, it's skipped (already seen/being processed).
 *
 * IMPORTANT: Google Docs API indices are 1-based (first char in body = index 1),
 * but our bodyText string is 0-based. We add +1 to all indices so the doc writer
 * inserts at the correct position in the document. We also cap the endIndex to
 * avoid inserting past the end of the document segment.
 */
import type { AppConfig, DocContent, PromptBlock } from './types.js';

// 👀 emoji = U+1F440, used as a marker that a prompt has already been seen
const EYES = '\uD83D\uDC40';

export class PromptScanner {
  private readonly trigger: string;
  private readonly triggerLower: string;
  private readonly endPattern: RegExp;
  private readonly eyes: string;

  constructor(config: AppConfig) {
    this.trigger = config.trigger_keyword;
    this.triggerLower = config.trigger_keyword.toLowerCase();
    this.eyes = config.seen_marker || '\uD83D\uDC40';
    // Convert the config end_pattern string to a RegExp
    // Default: \n\n (blank line)
    const patternStr = config.prompt_delimiter.end_pattern || '\\n\\n';
    this.endPattern = new RegExp(patternStr);
  }

  /**
   * Scan a doc's content and extract all prompt blocks.
   * Returns an array of PromptBlock with positions for the writer.
   *
   * Skips prompts that already have the 👀 marker (already seen).
   */
  scan(doc: DocContent): PromptBlock[] {
    const text = doc.bodyText;
    const prompts: PromptBlock[] = [];
    let searchOffset = 0;

    while (searchOffset < text.length) {
      // Case-insensitive search for the trigger
      const lowerText = text.slice(searchOffset).toLowerCase();
      const relativeIdx = lowerText.indexOf(this.triggerLower);
      if (relativeIdx === -1) break;
      const triggerIdx = searchOffset + relativeIdx;

      // The prompt text starts right after the trigger
      const promptStart = triggerIdx + this.trigger.length;

      // Find the end of the prompt block (blank line or delimiter)
      const endMatch = text.slice(promptStart).match(this.endPattern);
      let promptEnd: number;
      if (endMatch) {
        promptEnd = promptStart + endMatch.index!;
      } else {
        // No delimiter found — prompt goes to end of text
        promptEnd = text.length;
      }

      const promptText = text.slice(promptStart, promptEnd).trim();

      if (promptText.length > 0) {
        // Skip if the prompt already has the eyes marker (already seen/processed)
        if (promptText.includes(this.eyes)) {
          searchOffset = promptEnd;
          continue;
        }

        // Convert 0-based string indices to 1-based Google Docs API indices.
        // Cap at text.length to avoid "Index must be less than end index" errors
        // when the prompt extends to the very end of the document.
        const apiStartIndex = triggerIdx + 1;
        const apiEndIndex = Math.min(promptEnd + 1, text.length);

        prompts.push({
          docId: doc.docId,
          startIndex: apiStartIndex,
          endIndex: apiEndIndex,
          trigger: text.slice(triggerIdx, triggerIdx + this.trigger.length),
          promptText,
          hash: '', // No longer used — dedup is via the 👀 marker
        });
      }

      searchOffset = promptEnd;
    }

    return prompts;
  }
}