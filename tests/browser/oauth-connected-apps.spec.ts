import { expect, test } from '@playwright/test';
import { mockBrowserApi } from './fixtures';

const now = '2026-09-01T00:00:00.000Z';

test('edits a connected OAuth app using the API-key permission controls', async ({ page }) => {
  await mockBrowserApi(page);

  const authorization = {
    id: 'oauth_auth_browser',
    userId: 'user_browser',
    clientId: 'client_browser',
    scope: 'notes.read',
    accessMode: 'all' as const,
    sharedAccessMode: 'none' as const,
    collaborationGrantIds: [] as string[],
    canCreateFolders: false,
    canRead: true,
    canCreate: false,
    canEdit: false,
    canComment: false,
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
    lastUsedAt: null,
    client: {
      id: 'client_browser',
      userId: 'user_browser',
      name: 'Browser OAuth App',
      description: null,
      redirectUris: '["https://client.example/callback"]',
      clientType: 'public' as const,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    },
    permissions: [],
  };
  let updateBody: Record<string, unknown> | null = null;

  await page.route('**/internal/oauth/authorizations**', async (route) => {
    const request = route.request();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (request.method() === 'GET') return json({ authorizations: [authorization] });
    if (request.method() === 'PATCH') {
      updateBody = request.postDataJSON() as Record<string, unknown>;
      Object.assign(authorization, updateBody, {
        scope: [
          updateBody.canRead ? 'notes.read' : null,
          updateBody.canCreate ? 'notes.create' : null,
          updateBody.canEdit ? 'notes.edit' : null,
          updateBody.canComment ? 'comments.write' : null,
          updateBody.canCreateFolders ? 'folders.create' : null,
        ]
          .filter(Boolean)
          .join(' '),
        updatedAt: new Date().toISOString(),
      });
      return json({ ok: true });
    }

    return route.fulfill({ status: 405, body: 'Method not allowed' });
  });

  await page.goto('/integrations');
  await page.getByText('Browser OAuth App', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();

  const heading = page.getByRole('heading', { name: 'Edit Browser OAuth App access' });
  const dialog = heading.locator('xpath=ancestor::div[contains(@class, "max-w-2xl")]');
  await expect(dialog).toBeVisible();
  await dialog.getByText('Create', { exact: true }).click();
  await dialog.getByText('Comment', { exact: true }).click();
  await dialog.getByText('Allow folder creation', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();

  await expect
    .poll(() => updateBody)
    .toMatchObject({
      accessMode: 'all',
      canRead: true,
      canCreate: true,
      canEdit: false,
      canComment: true,
      canCreateFolders: true,
      sharedAccessMode: 'none',
      collaborationGrantIds: [],
      permissions: [],
    });
  await expect(page.getByText('Read · Create · Comment · Create folders')).toBeVisible();
});
