/**
 * Shared TypeScript types for doc-jarvis
 */

/** Application configuration loaded from config.json + environment variables */
export interface AppConfig {
  trigger_keyword: string;
  drive_search_keyword: string;
  poll_interval_ms: number;
  stream_interval_ms: number;
  openclaw: OpenClawConfig;
  google: GoogleConfig;
  prompt_delimiter: PromptDelimiterConfig;
}

export interface OpenClawConfig {
  gateway_url: string;
  gateway_token: string;
  session_key: string;
  model: string;
}

export interface GoogleConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  token_path: string;
}

export interface PromptDelimiterConfig {
  start: string;
  end_pattern: string;
}

/** A document discovered in Google Drive that contains the search keyword */
export interface DiscoveredDoc {
  id: string;
  title: string;
  modifiedTime: string;
}

/** Structural element from the Google Docs API (simplified) */
export interface DocElement {
  endIndex: number;
  startIndex: number;
  paragraph?: {
    elements: DocTextRun[];
  };
}

export interface DocTextRun {
  startIndex: number;
  endIndex: number;
  textRun?: {
    content: string;
  };
}

/** Result of fetching a doc's content */
export interface DocContent {
  docId: string;
  title: string;
  bodyText: string;
  elements: DocElement[];
}

/** A prompt block detected in a document */
export interface PromptBlock {
  docId: string;
  /** Start index of the trigger token in the doc body */
  startIndex: number;
  /** End index of the prompt text (exclusive) */
  endIndex: number;
  /** The trigger keyword (e.g. `@jarvis`) */
  trigger: string;
  /** The extracted prompt text (without the trigger token) */
  promptText: string;
  /** Stable hash of the prompt content for deduplication */
  hash: string;
}

/** The state of a prompt — tracked to avoid duplicate responses */
export interface PromptState {
  hash: string;
  docId: string;
  status: 'pending' | 'responding' | 'responded' | 'error';
  respondedAt?: string;
  error?: string;
}

/** Persisted prompt tracker state (state/prompts.json) */
export interface PromptTrackerState {
  prompts: Record<string, PromptState>;
  lastSaved: string;
}

/** A chunk of streamed response from OpenClaw */
export interface ResponseChunk {
  text: string;
  done: boolean;
}

/** Logger interface so modules can use a consistent logging API */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}