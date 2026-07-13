/**
 * Typing guard — detects whether the user is still typing in the prompt region.
 *
 * Since the Google Docs API doesn't directly expose cursor position, we infer
 * active typing by comparing content hashes across poll intervals:
 * - If the prompt region's content changes between polls, the user is likely still editing.
 * - We require N consecutive stable polls before considering the prompt "settled".
 */
import type { PromptBlock } from './types.js';

export class TypingGuard {
  /** Maps prompt text → previous content snapshot */
  private lastContent = new Map<string, string>();
  /** Maps prompt text → consecutive stable poll count */
  private stableCount = new Map<string, number>();
  /** Number of consecutive stable polls required before sending */
  private readonly requiredStable: number;
  /** Minimum prompt length to consider it non-empty */
  private readonly minLength: number;

  constructor(requiredStablePolls = 1, minLength = 3) {
    this.requiredStable = requiredStablePolls;
    this.minLength = minLength;
  }

  /**
   * Check whether the prompt is "settled" (user stopped typing).
   * Call this on each poll with the current prompt text.
   *
   * Returns true if the prompt has been stable for enough polls.
   */
  isSettled(prompt: PromptBlock): boolean {
    const current = prompt.promptText;

    if (current.length < this.minLength) {
      return false;
    }

    const previous = this.lastContent.get(prompt.promptText);

    if (previous === current) {
      const count = (this.stableCount.get(prompt.promptText) ?? 0) + 1;
      this.stableCount.set(prompt.promptText, count);
      this.lastContent.set(prompt.promptText, current);
      return count >= this.requiredStable;
    }

    // Content changed — reset
    this.lastContent.set(prompt.promptText, current);
    this.stableCount.set(prompt.promptText, 0);
    return false;
  }

  /** Reset state for a prompt (after it's been responded to) */
  forget(hash: string): void {
    this.lastContent.delete(hash);
    this.stableCount.delete(hash);
  }

  /** Reset all tracked state */
  reset(): void {
    this.lastContent.clear();
    this.stableCount.clear();
  }
}