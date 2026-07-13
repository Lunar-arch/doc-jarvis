/**
 * Command scanner + handler — detects @gateway-start, @gateway-restart,
 * @gateway-stop, @model, and @clear commands in Google Docs and executes them.
 *
 * Commands are detected by looking for known command tokens at the start
 * of a line (case-insensitive). Commands with the 👀 marker are skipped
 * (already handled).
 *
 * @gateway-start   — runs `openclaw gateway start`, polls until online
 * @gateway-restart — runs `openclaw gateway restart`, polls until online
 * @gateway-stop    — runs `openclaw gateway stop`, polls until offline
 * @model <name>    — patches the OpenClaw config via admin RPC (hot-reload)
 *                    Supports full format "ollama/glm-5.2:cloud" or short
 *                    format "glm-5.2:cloud" (auto-prepends current provider)
 * @clear           — clears the OpenClaw session for this doc, starting fresh
 */
import type { AppConfig, CommandBlock, DocContent, Logger } from './types.js';
import { DocsClient } from './docs.js';
import { GatewayManager } from './gateway_manager.js';
import { OpenClawClient } from './openclaw_client.js';

// 👀 emoji = U+1F440
const EYES = '\uD83D\uDC40';

// Known commands — matched case-insensitively at the start of a line
const COMMANDS = [
  'gateway-start',
  'gateway-restart',
  'gateway-stop',
  'model',
  'clear',
  // Config commands — change runtime settings from the doc
  'trigger-word',
  'drive-search-word',
  'poll-ms',
  'gateway-port',
  'gateway-token',
  'response-prefix',
  'seen-marker',
  'commands-enabled',
];

export class CommandHandler {
  private readonly docsClient: DocsClient;
  private readonly gatewayManager: GatewayManager;
  private readonly openclaw: OpenClawClient;
  private readonly config: AppConfig;
  private readonly log: Logger;
  /** Seen marker (from config, default 👀) */
  private readonly eyes: string;

  constructor(docsClient: DocsClient, config: AppConfig, openclaw: OpenClawClient, log: Logger) {
    this.docsClient = docsClient;
    this.config = config;
    this.gatewayManager = new GatewayManager(config.openclaw.gateway_url, log);
    this.openclaw = openclaw;
    this.log = log;
    this.eyes = config.seen_marker || EYES;
  }

  /**
   * Scan a doc for commands and return any that haven't been handled yet
   * (i.e. don't have the 👀 marker).
   */
  scan(doc: DocContent): CommandBlock[] {
    const text = doc.bodyText;
    const commands: CommandBlock[] = [];
    const lines = text.split('\n');

    let currentOffset = 0;

    for (const line of lines) {
      const trimmedLine = line.trimStart();
      const lowerLine = trimmedLine.toLowerCase();

      // Check if this line starts with a known command
      for (const cmd of COMMANDS) {
        const cmdTrigger = `@${cmd}`;
        if (lowerLine.startsWith(cmdTrigger)) {
          // Extract the text after the command trigger
          const afterCommand = trimmedLine.slice(cmdTrigger.length);
          const fullText = trimmedLine.slice(1); // everything after @

          // Skip if already has 👀 marker (already handled)
          if (afterCommand.includes(this.eyes)) continue;

          // Find the start index of this line in the full text
          const lineStartInText = text.indexOf(line, currentOffset);
          const cmdStartInText = lineStartInText + (line.length - trimmedLine.length);

          // The command trigger starts at cmdStartInText
          // Find where the command text ends (end of this line)
          const lineEndInText = lineStartInText + line.length;

          // Extract args (everything after the command name, trimmed)
          let args = afterCommand.trim();
          // Remove any trailing seen marker that might have been partially added
          args = args.replace(this.eyes, '').trim();

          // Convert to 1-based API indices, cap to avoid end-of-segment errors
          const apiStartIndex = cmdStartInText + 1;
          const apiEndIndex = Math.min(lineEndInText + 1, text.length);

          commands.push({
            docId: doc.docId,
            startIndex: apiStartIndex,
            endIndex: apiEndIndex,
            command: cmd,
            args,
            fullText,
          });
          break;
        }
      }

      currentOffset += line.length + 1; // +1 for the \n
    }

    return commands;
  }

  /**
   * Handle a command: insert 👀, execute the command, write the result.
   */
  async handle(cmd: CommandBlock): Promise<void> {
    this.log.info(`Handling command: @${cmd.command} ${cmd.args}`);

    // Step 1: Insert 👀 right after the command text
    const needsSpace = cmd.fullText.length > 0 && !cmd.fullText.endsWith(' ');
    const eyesText = needsSpace ? ` ${this.eyes}` : this.eyes;
    await this.docsClient.insertText(cmd.docId, eyesText, cmd.endIndex);

    try {
      let result: string;

      switch (cmd.command) {
        case 'gateway-start':
          result = await this.gatewayManager.start();
          break;
        case 'gateway-restart':
          result = await this.gatewayManager.restart();
          break;
        case 'gateway-stop':
          result = await this.gatewayManager.stop();
          break;
        case 'model':
          result = await this.handleModel(cmd.args);
          break;
        case 'clear':
          result = await this.handleClear(cmd.docId);
          break;
        // Config commands — modify runtime settings
        case 'trigger-word':
          result = this.handleConfigString(cmd.args, 'trigger_keyword', 'Trigger word');
          break;
        case 'drive-search-word':
          result = this.handleConfigString(cmd.args, 'drive_search_keyword', 'Drive search word');
          break;
        case 'poll-ms':
          result = this.handleConfigNumber(cmd.args, 'poll_interval_ms', 'Poll interval');
          break;
        case 'gateway-port':
          result = this.handleGatewayPort(cmd.args);
          break;
        case 'gateway-token':
          result = this.handleConfigString(cmd.args, 'openclaw.gateway_token', 'Gateway token', true);
          break;
        case 'response-prefix':
          result = this.handleConfigString(cmd.args, 'response_prefix', 'Response prefix');
          break;
        case 'seen-marker':
          result = this.handleConfigString(cmd.args, 'seen_marker', 'Seen marker');
          break;
        case 'commands-enabled':
          result = this.handleConfigBoolean(cmd.args, 'commands_enabled', 'Commands enabled');
          break;
        default:
          result = `Unknown command: ${cmd.command}`;
      }

      // Step 2: Write the result on the same line after the 👀
      const resultStart = cmd.endIndex + eyesText.length;
      await this.docsClient.insertText(cmd.docId, ` ${result}`, resultStart);

      this.log.info(`Command @${cmd.command} result: ${result}`);
    } catch (err) {
      // Write error after the eyes
      const resultStart = cmd.endIndex + eyesText.length;
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.docsClient.insertText(cmd.docId, ` Error: ${errorMsg}`, resultStart);
      this.log.error(`Command @${cmd.command} failed:`, err);
    }
  }

  /**
   * Handle @clear command — clears the OpenClaw session for this doc.
   * The next @jarvis prompt will start a fresh conversation with no context.
   */
  private async handleClear(docId: string): Promise<string> {
    const newKey = this.openclaw.clearSession(docId);
    return `Session cleared (new key: ${newKey})`;
  }

  /**
   * Handle @model command — patches the OpenClaw config via admin RPC.
   *
   * Supports:
   * - Full format: "ollama/glm-5.2:cloud" → uses as-is
   * - Short format: "glm-5.2:cloud" → auto-prepends current provider
   *   (extracted from the current model string in config)
   */
  private async handleModel(modelArg: string): Promise<string> {
    if (!modelArg) return 'Error: no model specified';

    // Determine the full model string
    let fullModel: string;

    if (modelArg.includes('/')) {
      // Full format: "ollama/glm-5.2:cloud" — use as-is
      fullModel = modelArg;
    } else {
      // Short format: "glm-5.2:cloud" — prepend current provider
      const currentModel = this.config.openclaw.model || '';
      const slashIdx = currentModel.indexOf('/');
      if (slashIdx > 0) {
        const provider = currentModel.slice(0, slashIdx);
        fullModel = `${provider}/${modelArg}`;
      } else {
        // No provider in current config — can't infer
        return `Error: no provider prefix in current model "${currentModel}" — use full format like "ollama/${modelArg}"`;
      }
    }

    this.log.info(`Patching model to: ${fullModel}`);

    // Use the admin RPC endpoint: /api/v1/admin/rpc
    // config.patch requires: method, params: { baseHash, raw }
    // 1. GET current config hash via config.get
    // 2. PATCH with the new model via config.patch (hot-reload, no restart)
    const rpcUrl = `${this.config.openclaw.gateway_url.replace(/\/$/, '')}/api/v1/admin/rpc`;
    const authHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.openclaw.gateway_token
        ? { Authorization: `Bearer ${this.config.openclaw.gateway_token}` }
        : {}),
    };

    // Step 1: Get current config hash
    const getRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ method: 'config.get', params: {} }),
    });
    if (!getRes.ok) {
      throw new Error(`config.get failed (${getRes.status}): ${await getRes.text()}`);
    }
    const getData = await getRes.json() as { ok: boolean; payload?: { hash?: string }; error?: { message?: string } };
    if (!getData.ok || !getData.payload?.hash) {
      throw new Error(`config.get failed: ${getData.error?.message ?? 'no hash returned'}`);
    }
    const baseHash = getData.payload.hash;

    // Step 2: Patch the config with the new model
    const patchRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        method: 'config.patch',
        params: {
          baseHash,
          raw: JSON.stringify({
            agents: {
              defaults: {
                model: { primary: fullModel },
              },
            },
          }),
        },
      }),
    });

    if (!patchRes.ok) {
      const text = await patchRes.text();
      throw new Error(`config.patch failed (${patchRes.status}): ${text}`);
    }

    const patchData = await patchRes.json() as { ok: boolean; error?: { message?: string } };
    if (!patchData.ok) {
      throw new Error(`config.patch failed: ${patchData.error?.message ?? 'unknown error'}`);
    }

    // Update our local config so future short-format @model commands work
    this.config.openclaw.model = fullModel;

    return `Model changed to: ${fullModel}`;
  }

  // ─── Config-setting commands ───────────────────────────────────────────

  /** Set a string config field at runtime */
  private handleConfigString(args: string, field: string, label: string, sensitive = false): string {
    if (!args) return `Error: no value specified. Usage: @${field} <value>`;
    this.setConfigField(field, args);
    const display = sensitive ? '****' : args;
    return `${label} changed to: ${display}`;
  }

  /** Set a number config field at runtime */
  private handleConfigNumber(args: string, field: string, label: string): string {
    if (!args) return `Error: no value specified. Usage: @${field} <number>`;
    const num = parseInt(args, 10);
    if (isNaN(num)) return `Error: "${args}" is not a valid number`;
    this.setConfigField(field, num);
    return `${label} changed to: ${num}ms`;
  }

  /** Set a boolean config field at runtime */
  private handleConfigBoolean(args: string, field: string, label: string): string {
    if (!args) return `Error: no value specified. Usage: @${field} true|false`;
    const val = args.toLowerCase() === 'true' || args === '1' || args.toLowerCase() === 'on';
    this.setConfigField(field, val);
    return `${label} changed to: ${val}`;
  }

  /** Special handling for gateway port — updates gateway_url */
  private handleGatewayPort(args: string): string {
    if (!args) return 'Error: no port specified. Usage: @gateway-port <port>';
    const port = parseInt(args, 10);
    if (isNaN(port) || port < 1 || port > 65535) return `Error: "${args}" is not a valid port (1-65535)`;
    // Update the gateway URL with the new port
    const url = new URL(this.config.openclaw.gateway_url);
    url.port = String(port);
    this.config.openclaw.gateway_url = url.toString();
    return `Gateway port changed to: ${port} (URL: ${this.config.openclaw.gateway_url})`;
  }

  /**
   * Set a config field using dot notation (e.g. "openclaw.gateway_token").
   * Modifies the in-memory config at runtime — changes are lost on restart
   * unless saved to config.json.
   */
  private setConfigField(field: string, value: string | number | boolean): void {
    const parts = field.split('.');
    let target: Record<string, unknown> = this.config as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
    this.log.info(`Config updated: ${field} = ${typeof value === 'string' && value.length > 20 ? value.slice(0, 20) + '...' : value}`);
  }
}