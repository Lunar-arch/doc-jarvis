/**
 * Google OAuth helper — handles token storage, refresh, and first-run consent flow.
 */
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AppConfig, Logger } from './types.js';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];

/**
 * Load a stored token or run the OAuth consent flow if none exists.
 * Returns an authenticated OAuth2Client.
 */
export async function loadOrAuthGoogle(config: AppConfig, log: Logger): Promise<OAuth2Client> {
  const { client_id, client_secret, redirect_uri, token_path } = config.google;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  const absTokenPath = resolve(token_path);

  if (existsSync(absTokenPath)) {
    const token = JSON.parse(readFileSync(absTokenPath, 'utf-8'));
    oauth2Client.setCredentials(token);
    log.info('Loaded stored Google OAuth token');
  } else {
    log.info('No token found — starting OAuth consent flow');
    await runConsentFlow(oauth2Client, absTokenPath, log, config.google.redirect_uri);
  }

  // Auto-refresh on expiry — persist updated tokens (access_token and/or refresh_token)
  oauth2Client.on('tokens', (tokens) => {
    try {
      log.debug('Token refresh event received — persisting updated credentials');
      const existing = existsSync(absTokenPath)
        ? JSON.parse(readFileSync(absTokenPath, 'utf-8'))
        : {};
      writeFileSync(absTokenPath, JSON.stringify({ ...existing, ...tokens }, null, 2));
    } catch (err) {
      log.warn('Failed to persist refreshed token:', err);
    }
  });

  return oauth2Client;
}

async function runConsentFlow(oauth2Client: OAuth2Client, tokenPath: string, log: Logger, redirectUri: string): Promise<void> {
  // Generate a random state parameter for CSRF protection
  const state = cryptoRandomString();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });

  log.info('Attempting to open your browser for Google authorization...');
  log.info('If it doesn\'t open, copy this URL manually:');
  log.info(authUrl);

  // Auto-open the auth URL in the user\'s default browser
  openInBrowser(authUrl, log);

  // Simple local server to capture the callback
  const url = new URL(redirectUri);
  const port = parseInt(url.port ?? '8080', 10);

  const { createServer } = await import('node:http');
  return new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '', `http://localhost:${port}`);
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      const returnedState = reqUrl.searchParams.get('state');

      // Validate state parameter (CSRF protection)
      if (!returnedState || returnedState !== state) {
        res.writeHead(400);
        res.end('Authorization error: invalid state parameter (possible CSRF attack)');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      if (error) {
        res.writeHead(400);
        res.end(`Authorization error: ${error}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        try {
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          mkdirSync(dirname(tokenPath), { recursive: true });
          writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
          log.info('OAuth token saved to', tokenPath);

          res.writeHead(200);
          res.end('Authorization successful! You can close this tab.');
          server.close();
          resolve();
        } catch (err) {
          res.writeHead(500);
          res.end(`Token exchange failed: ${err}`);
          server.close();
          reject(err);
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(port, () => {
      log.info(`OAuth callback server listening on port ${port}`);
    });

    server.on('error', reject);

    // Timeout: reject if user doesn't authorize within 10 minutes
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth consent flow timed out after 10 minutes'));
    }, 10 * 60 * 1000);

    // Clear timeout on success or error
    server.on('close', () => clearTimeout(timeout));
  });
}

/** Generate a cryptographically random hex string for OAuth state */
function cryptoRandomString(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Open a URL in the user\'s default browser, cross-platform.
 * Falls back gracefully if the command fails — the URL is already printed
 * to the terminal so the user can copy-paste it manually.
 */
function openInBrowser(url: string, log: Logger): void {
  const platform = process.platform;
  let command: string;

  if (platform === 'win32') {
    // Windows: `start` opens via the default associated program
    command = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    // macOS
    command = `open "${url}"`;
  } else {
    // Linux / other — try xdg-open (common on most desktop distros)
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      log.warn('Could not auto-open browser — please copy the URL above into your browser manually.');
    } else {
      log.info('Browser opened — complete the Google consent flow to continue.');
    }
  });
}