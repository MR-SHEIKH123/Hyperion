import type { Response } from 'express';

/**
 * Turn a response into a file download.
 *
 * All three export routes (chat, artifact, code task) need the same two
 * headers, and the filename travels through `Content-Disposition` — a stored
 * artifact's rel_path is sanitised before it ever reaches this function, but
 * the quotes here are the last line of defence against a filename breaking the
 * header apart.
 */
export function attachDownloadHeaders(res: Response, filename: string, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
}
