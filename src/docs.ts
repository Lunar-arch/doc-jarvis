/**
 * Google Docs API client — fetch doc content and insert text via batch updates.
 */
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig, DocContent, Logger } from './types.js';

export class DocsClient {
  private readonly config: AppConfig;
  private readonly log: Logger;
  private oauth2Client: OAuth2Client | null = null;

  constructor(config: AppConfig, log: Logger, oauth2Client?: OAuth2Client) {
    this.config = config;
    this.log = log;
    if (oauth2Client) this.oauth2Client = oauth2Client;
  }

  /** Set the authenticated OAuth client (shared from DriveClient) */
  setAuthClient(client: OAuth2Client): void {
    this.oauth2Client = client;
  }

  /**
   * Fetch the full content of a document.
   * Returns plain text + structural elements.
   */
  async getDoc(docId: string): Promise<DocContent> {
    if (!this.oauth2Client) throw new Error('Docs client not initialised');

    const docs = google.docs({ version: 'v1', auth: this.oauth2Client });

    try {
      const res = await docs.documents.get({ documentId: docId });
      const doc = res.data;
      const bodyText = extractText(doc);
      const elements = (doc.body?.content ?? []).map((el) => ({
        startIndex: el.startIndex ?? 0,
        endIndex: el.endIndex ?? 0,
        paragraph: el.paragraph
          ? {
              elements: (el.paragraph.elements ?? []).map((pe) => ({
                startIndex: pe.startIndex ?? 0,
                endIndex: pe.endIndex ?? 0,
                textRun: pe.textRun ? { content: pe.textRun.content ?? '' } : undefined,
              })),
            }
          : undefined,
      }));

      return {
        docId,
        title: doc.title ?? '',
        bodyText,
        elements,
      };
    } catch (err) {
      this.log.error(`Failed to fetch doc ${docId}:`, err);
      throw err;
    }
  }

  /**
   * Insert text at a specific position in the document using a batch update.
   * Used by the doc writer to stream responses.
   */
  async insertText(docId: string, text: string, index: number): Promise<void> {
    if (!this.oauth2Client) throw new Error('Docs client not initialised');

    const docs = google.docs({ version: 'v1', auth: this.oauth2Client });

    try {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index },
                text,
              },
            },
          ],
        },
      });
    } catch (err) {
      this.log.error(`Failed to insert text into doc ${docId}:`, err);
      throw err;
    }
  }

  /**
   * Delete a range of text (used to remove the trigger token if needed).
   */
  async deleteRange(docId: string, startIndex: number, endIndex: number): Promise<void> {
    if (!this.oauth2Client) throw new Error('Docs client not initialised');

    const docs = google.docs({ version: 'v1', auth: this.oauth2Client });

    try {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              deleteContentRange: {
                range: { startIndex, endIndex },
              },
            },
          ],
        },
      });
    } catch (err) {
      this.log.error(`Failed to delete range in doc ${docId}:`, err);
      throw err;
    }
  }
}

/** Simplified document type for text extraction */
interface DocBody {
  body?: {
    content?: Array<{
      paragraph?: {
        elements?: Array<{
          textRun?: { content?: string | null };
        } | null> | null;
      } | null;
    } | null> | null;
  } | null;
}

/** Extract plain text from a Google Docs API document response */
function extractText(doc: DocBody): string {
  const elements = doc.body?.content ?? [];
  let text = '';
  for (const el of elements) {
    if (!el) continue;
    const runs = el.paragraph?.elements ?? [];
    for (const run of runs) {
      if (!run) continue;
      text += run.textRun?.content ?? '';
    }
  }
  return text;
}