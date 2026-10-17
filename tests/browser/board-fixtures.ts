import type { Page } from '@playwright/test';
import { mockBrowserApi } from './fixtures';

/** Shared auth/note fixtures; board fixtures are property-only in property-board-fixtures. */
export async function mockBoardApi(page: Page, options: { role?: 'owner' | 'viewer' | 'commenter' | 'editor' } = {}) {
  const existing = await mockBrowserApi(page, { folderAccessRole: options.role ?? 'owner' });
  const requests: Array<{ path: string; method: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/internal/')) requests.push({ path: url.pathname, method: request.method() });
  });
  return { ...existing, requests };
}
