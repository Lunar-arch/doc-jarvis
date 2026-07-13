/**
 * Entry point — starts the polling loop that monitors Drive for prompts.
 *
 * Flow:
 * 1. Load config + validate
 * 2. Authenticate with Google OAuth
 * 3. Every poll_interval_ms:
 *    a. Search Drive for docs with the keyword
 *    b. Fetch each doc's content
 *    c. Scan for prompt blocks
 *    d. For each settled, unresponded prompt:
 *       - Send to OpenClaw
 *       - Stream response back into the doc
 *       - Mark as responded
 * 4. Graceful shutdown on SIGINT/SIGTERM
 */
import 'dotenv/config';
import { loadConfig, validateConfig } from './config.js';
import { DriveClient } from './drive.js';
import { DocsClient } from './docs.js';
import { PromptScanner } from './prompt_scanner.js';
import { TypingGuard } from './typing_guard.js';
import { OpenClawClient } from './openclaw_client.js';
import { DocWriter } from './doc_writer.js';
import { CommandHandler } from './commands.js';
import type { AppConfig, Logger } from './types.js';

const logger: Logger = {
  info: (msg, ...args) => console.log(`[INFO]  ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[WARN]  ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  debug: (msg, ...args) => {
    if (process.env.DEBUG) console.debug(`[DEBUG] ${msg}`, ...args);
  },
};

async function main(): Promise<void> {
  const config: AppConfig = loadConfig();

  try {
    validateConfig(config);
  } catch (err) {
    logger.error('Configuration error:', err);
    process.exit(1);
  }

  logger.info('doc-jarvis starting...');
  logger.info(`Trigger: "${config.trigger_keyword}" | Poll: ${config.poll_interval_ms}ms`);

  // Initialise clients
  const driveClient = new DriveClient(config, logger);
  await driveClient.init();

  const docsClient = new DocsClient(config, logger, driveClient.getAuthClient());

  const scanner = new PromptScanner(config);
  const typingGuard = new TypingGuard();
  const openclaw = new OpenClawClient(config, logger);
  const writer = new DocWriter(docsClient, config, logger);
  const commandHandler = new CommandHandler(docsClient, config, openclaw, logger);

  // Check gateway health
  const healthy = await openclaw.healthCheck();
  if (!healthy) {
    logger.warn(`OpenClaw Gateway at ${config.openclaw.gateway_url} is not reachable — responses will fail`);
  }

  // Graceful shutdown
  let running = true;
  const shutdown = async () => {
    logger.info('Shutting down...');
    running = false;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Main polling loop
  while (running) {
    try {
      logger.debug('Polling Drive for docs...');
      const docs = await driveClient.searchDocs();
      logger.debug(`Found ${docs.length} docs with keyword "${config.drive_search_keyword}"`);

      // Process docs concurrently
      await Promise.allSettled(
        docs.map((docInfo) =>
          processDoc(docInfo.id, docsClient, scanner, typingGuard, openclaw, writer, commandHandler, logger),
        ),
      );
    } catch (err) {
      logger.error('Polling error:', err);
    }

    // Wait for next poll interval
    await sleep(config.poll_interval_ms);
  }

  logger.info('Goodbye');
}

async function processDoc(
  docId: string,
  docsClient: DocsClient,
  scanner: PromptScanner,
  typingGuard: TypingGuard,
  openclaw: OpenClawClient,
  writer: DocWriter,
  commandHandler: CommandHandler,
  log: Logger,
): Promise<void> {
  try {
    const doc = await docsClient.getDoc(docId);

    // Step 1: Check for commands first (they take priority over prompts)
    // But skip command processing if commands are disabled via @commands-enabled false
    const commands = commandHandler.scan(doc);
    for (const cmd of commands) {
      log.info(`Detected command @${cmd.command} in doc ${docId}`);
      // Apply typing guard to commands too — wait for user to stop typing
      if (!typingGuard.isSettled({ docId, startIndex: 0, endIndex: 0, trigger: '', promptText: cmd.fullText, hash: '' })) {
        log.debug(`Command @${cmd.command} not settled yet — skipping`);
        continue;
      }
      await commandHandler.handle(cmd);
      typingGuard.forget(cmd.fullText);
    }

    // Step 2: Check for regular @jarvis prompts
    const prompts = scanner.scan(doc);
    if (prompts.length === 0) return;

    log.debug(`Doc ${docId}: found ${prompts.length} prompt block(s)`);

    for (const prompt of prompts) {
      // The scanner already skips prompts that have the 👀 marker,
      // so any prompt we get here is fresh and needs a response.

      // Skip if user is still typing
      if (!typingGuard.isSettled(prompt)) {
        log.debug(`Prompt not settled yet — skipping`);
        continue;
      }

      log.info(`Sending prompt from doc ${docId} to OpenClaw`);

      try {
        const chunks = openclaw.sendPrompt(docId, prompt.promptText);
        await writer.writeResponse(prompt, chunks);
        typingGuard.forget(prompt.promptText);
      } catch (err) {
        log.error(`Failed to process prompt:`, err);
      }
    }
  } catch (err) {
    log.error(`Failed to process doc ${docId}:`, err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});