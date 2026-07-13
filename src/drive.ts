/**
 * Google Drive API client — discover docs by title keyword.
 */
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig, DiscoveredDoc, Logger } from './types.js';
import { loadOrAuthGoogle } from './auth.js';

export class DriveClient {
  private oauth2Client: OAuth2Client | null = null;
  private readonly config: AppConfig;
  private readonly log: Logger;

  constructor(config: AppConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  /** Initialise OAuth and return when authenticated */
  async init(): Promise<void> {
    this.oauth2Client = await loadOrAuthGoogle(this.config, this.log);
    this.log.info('Drive client authenticated');
  }

  /**
   * Search the user's Drive for docs whose **title** contains the configured keyword.
   * Uses the Drive API `name contains` query (title search) instead of `fullText contains`
   * so results are immediate — Google's full-text index takes minutes to update, but
   * title metadata is indexed instantly.
   *
   * Handles pagination to retrieve all matching results.
   * Escapes single quotes in the keyword to prevent query injection.
   */
  async searchDocs(): Promise<DiscoveredDoc[]> {
    if (!this.oauth2Client) throw new Error('Drive client not initialised — call init() first');

    const drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    // Escape single quotes in the keyword for the Drive query string
    // Note: Drive API `name contains` is case-insensitive by default
    const keyword = this.config.drive_search_keyword.replace(/'/g, "\\'");

    const results: DiscoveredDoc[] = [];
    let pageToken: string | undefined;

    try {
      do {
        const res = await drive.files.list({
          q: `name contains '${keyword}' and mimeType='application/vnd.google-apps.document' and trashed=false`,
          fields: 'nextPageToken, files(id, name, modifiedTime)',
          pageSize: 100,
          spaces: 'drive',
          pageToken,
        });

        const files = res.data.files ?? [];
        for (const f of files) {
          results.push({
            id: f.id!,
            title: f.name!,
            modifiedTime: f.modifiedTime ?? '',
          });
        }

        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);

      return results;
    } catch (err) {
      this.log.error('Drive search failed:', err);
      throw err;
    }
  }

  /** Get the authenticated OAuth2 client (used by DocsClient) */
  getAuthClient(): OAuth2Client {
    if (!this.oauth2Client) throw new Error('Drive client not initialised');
    return this.oauth2Client;
  }
}