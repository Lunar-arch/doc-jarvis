/**
 * Prompt scanner — searches doc content for the trigger keyword and extracts prompt blocks.
 *
 * A prompt block starts with the trigger token (e.g. `@jarvis`) and ends at:
 * - A blank line (double newline `\n\n`)
 * - Or an explicit end delimiter if configured
 *
 * Matching is case-insensitive — `@Jarvis`, `@JARVIS`, `@jarvis` all match.
 * If a prompt already has the 👀 eyes marker, it's skipped (already seen/being processed).
 */
import type { AppConfig, DocContent, PromptBlock } from './types.js';

// 👀 emoji = U+1F440, used as a marker that a prompt has already been seen
const EYES = '\uD83D\uDC40';

export class PromptScanner {
  private readonly trigger: string;
  private readonly triggerLower: string;
  private readonly endPattern: RegExp;

  constructor(config: AppConfig) {
    this.trigger = config.trigger_keyword;
    this.triggerLower = config.trigger_keyword.toLowerCase();
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
        // Skip if the prompt already has the 👀 marker (already seen/processed)
        if (promptText.includes(EYES)) {
          searchOffset = promptEnd;
          continue;
        }

        prompts.push({
          docId: doc.docId,
          startIndex: triggerIdx,
          endIndex: promptEnd,
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