/**
 * Gateway manager — start, stop, restart the OpenClaw gateway via shell commands,
 * then poll the health endpoint to confirm the gateway is up/down.
 *
 * Uses the same patterns as the openclaw-dashboard:
 * - spawn("openclaw", ["gateway", "start|stop|restart"])
 * - Poll http://127.0.0.1:18789/healthz every 3s until online/offline
 * - Success heuristic: exit code 0 OR output contains verb without "error"/"fail"
 */
import { spawn } from 'node:child_process';
import type { Logger } from './types.js';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60_000;
const HEALTH_ENDPOINT = '/healthz';

export class GatewayManager {
  private readonly gatewayUrl: string;
  private readonly log: Logger;

  constructor(gatewayUrl: string, log: Logger) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, '');
    this.log = log;
  }

  /** Start the gateway and wait until it's online */
  async start(): Promise<string> {
    this.log.info('Starting OpenClaw gateway...');
    await this.runGatewayCommand('start');
    const online = await this.waitForOnline();
    return online ? 'Gateway Started' : 'Gateway start timed out';
  }

  /** Restart the gateway and wait until it's online */
  async restart(): Promise<string> {
    this.log.info('Restarting OpenClaw gateway...');
    await this.runGatewayCommand('restart');
    const online = await this.waitForOnline();
    return online ? 'Gateway Restarted' : 'Gateway restart timed out';
  }

  /** Stop the gateway and wait until it's offline */
  async stop(): Promise<string> {
    this.log.info('Stopping OpenClaw gateway...');
    await this.runGatewayCommand('stop');
    const offline = await this.waitForOffline();
    return offline ? 'Gateway Stopped' : 'Gateway stop timed out';
  }

  /** Run an openclaw gateway command via child_process.spawn */
  private runGatewayCommand(action: 'start' | 'stop' | 'restart'): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('openclaw', ['gateway', action], {
        shell: true,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        this.log.debug(`[gateway ${action}] ${text.trim()}`);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        this.log.debug(`[gateway ${action} stderr] ${text.trim()}`);
      });

      child.on('close', (code: number | null) => {
        const output = (stdout + stderr).toLowerCase();
        const looksLikeSuccess =
          (output.includes(action) && !output.includes('error') && !output.includes('fail')) ||
          code === 0;

        if (looksLikeSuccess) {
          this.log.info(`Gateway ${action} command succeeded (exit code ${code})`);
          resolve();
        } else {
          this.log.error(`Gateway ${action} command failed (exit code ${code}): ${stdout + stderr}`);
          reject(new Error(`Gateway ${action} failed: ${stdout + stderr}`));
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn openclaw gateway ${action}: ${err.message}`));
      });
    });
  }

  /** Poll the health endpoint until the gateway responds (or timeout) */
  private async waitForOnline(): Promise<boolean> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isOnline()) {
        this.log.info('Gateway is online');
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  /** Poll the health endpoint until the gateway stops responding (or timeout) */
  private async waitForOffline(): Promise<boolean> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.isOnline())) {
        this.log.info('Gateway is offline');
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  /** Check if the gateway is currently online */
  private async isOnline(): Promise<boolean> {
    try {
      const res = await fetch(`${this.gatewayUrl}${HEALTH_ENDPOINT}`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}