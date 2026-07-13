/**
 * Prompt tracker — tracks which prompts have been responded to.
 *
 * State persists to `state/prompts.json` so it survives restarts.
 * A prompt is identified by a stable hash (docId + position + content).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Logger, PromptBlock, PromptTrackerState } from './types.js';

const DEFAULT_STATE_PATH = './state/prompts.json';

export class PromptTracker {
  private state: PromptTrackerState;
  private readonly statePath: string;
  private readonly log: Logger;

  constructor(log: Logger, statePath = DEFAULT_STATE_PATH) {
    this.log = log;
    this.statePath = resolve(statePath);
    this.state = this.load();
  }

  /** Load persisted state from disk */
  private load(): PromptTrackerState {
    if (existsSync(this.statePath)) {
      try {
        const raw = readFileSync(this.statePath, 'utf-8');
        return JSON.parse(raw) as PromptTrackerState;
      } catch (err) {
        this.log.warn(`Failed to load prompt state (${err}) — starting fresh`);
      }
    }
    return { prompts: {}, lastSaved: '' };
  }

  /** Save state to disk */
  private save(): void {
    this.state.lastSaved = new Date().toISOString();
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.error('Failed to save prompt state:', err);
    }
  }

  /** Check if a prompt has already been responded to (or is in progress) */
  hasBeenHandled(prompt: PromptBlock): boolean {
    const entry = this.state.prompts[prompt.hash];
    return entry != null && (entry.status === 'responded' || entry.status === 'responding');
  }

  /** Mark a prompt as in-progress (sending to OpenClaw) */
  markResponding(prompt: PromptBlock): void {
    this.state.prompts[prompt.hash] = {
      hash: prompt.hash,
      docId: prompt.docId,
      status: 'responding',
    };
    this.save();
  }

  /** Mark a prompt as successfully responded */
  markResponded(prompt: PromptBlock): void {
    this.state.prompts[prompt.hash] = {
      hash: prompt.hash,
      docId: prompt.docId,
      status: 'responded',
      respondedAt: new Date().toISOString(),
    };
    this.save();
  }

  /** Mark a prompt as errored */
  markError(prompt: PromptBlock, error: string): void {
    this.state.prompts[prompt.hash] = {
      hash: prompt.hash,
      docId: prompt.docId,
      status: 'error',
      error,
    };
    this.save();
  }

  /** Remove all state for a doc (e.g. if the doc is deleted) */
  pruneByDocId(docId: string): void {
    for (const [hash, entry] of Object.entries(this.state.prompts)) {
      if (entry.docId === docId) {
        delete this.state.prompts[hash];
      }
    }
    this.save();
  }

  /** Get a count of prompts by status */
  getStats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of Object.values(this.state.prompts)) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return counts;
  }
}