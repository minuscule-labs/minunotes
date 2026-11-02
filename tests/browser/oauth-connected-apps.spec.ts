import { expect, type Page, test } from '@playwright/test';
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

  await page.route('**/internal/oauth/clients', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clients: [authorization.client] }),
    })
  );
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
  await expect(page.getByTestId('oauth-app-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Connected apps', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('oauth-app-row').getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'App details and actions for Browser OAuth App' }).click();
  await page.getByRole('button', { name: 'Edit access', exact: true }).click();

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

async function mockConsent(page: Page, scope?: string) {
  await mockBrowserApi(page);
  await page.route('**/internal/oauth/authorize/preview?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        client: { name: 'Consent Test App', description: null },
        request: { scope: scope ?? fullScope, state: 'test-state', redirectUri: 'https://client.example/callback' },
      }),
    })
  );
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'client_browser',
    redirect_uri: 'https://client.example/callback',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    ...(scope === undefined ? {} : { scope }),
    state: 'test-state',
  });
  await page.goto(`/oauth/authorize?${params}`);
  await expect(page.getByRole('heading', { name: 'Authorize Consent Test App' })).toBeVisible();
}

const fullScope = 'notes.read notes.create notes.edit comments.write folders.create';

test('API-key creation retains names, permissions, and one-time token display', async ({ page }) => {
  await mockBrowserApi(page);
  let body: Record<string, unknown> | null = null;
  await page.route('**/internal/api-keys', (route) => {
    if (route.request().method() === 'POST') {
      body = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ key: 'ntak_browser_test' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys: [] }) });
  });
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create key', exact: true }).last()).toBeDisabled();
  await page.getByRole('textbox', { name: 'Key name', exact: true }).fill('Browser key');
  await page.getByRole('checkbox', { name: 'Comment', exact: true }).check();
  await page.getByRole('button', { name: 'Create key', exact: true }).last().click();
  await expect(page.getByText('Copy this key now. It will not be shown again.')).toBeVisible();
  await expect(page.getByText('ntak_browser_test', { exact: true })).toBeVisible();
  expect(body).toMatchObject({ name: 'Browser key', accessMode: 'all', canRead: true, canComment: true });
  await page.getByRole('button', { name: 'Close API key access' }).click();
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Key name', exact: true })).toHaveValue('');
  await expect(page.getByText('ntak_browser_test', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Comment', exact: true })).not.toBeChecked();
});

for (const scope of [undefined, fullScope]) {
  test(`first-time consent with ${scope === undefined ? 'no scope parameter' : 'all requested scopes'} keeps unselected permissions off`, async ({
    page,
  }) => {
    await mockConsent(page, scope);
    let body: Record<string, unknown> | null = null;
    await page.route('**/internal/oauth/authorize/approve', (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { redirectUrl: '/integrations' } });
    });
    await expect(page.getByRole('checkbox', { name: 'Read', exact: true })).toBeChecked();
    for (const name of ['Create', 'Comment', 'Edit', /Allow folder creation/]) {
      const checkbox = page.getByRole('checkbox', { name, exact: true });
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).not.toBeChecked();
    }
    await page.getByRole('button', { name: 'Allow access' }).click();
    await expect
      .poll(() => body)
      .toMatchObject({
        accessMode: 'all',
        canRead: true,
        canCreate: false,
        canEdit: false,
        canComment: false,
        canCreateFolders: false,
        sharedAccessMode: 'none',
        collaborationGrantIds: [],
        permissions: [],
      });
    if (scope === undefined) expect(body).not.toHaveProperty('scope');
    else expect(body).toHaveProperty('scope', scope);
    await expect(page).toHaveURL(/\/integrations$/);
  });
}

test('create-only OAuth requests do not silently add Read', async ({ page }) => {
  await mockConsent(page, 'notes.create');
  const read = page.getByRole('checkbox', { name: 'Read', exact: true });
  await expect(read).toBeEnabled();
  await expect(read).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Create', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeEnabled();
});

test('project-root consent limits search to roots and clears rules on scope changes', async ({ page }) => {
  await mockConsent(page, fullScope);
  await page.getByRole('radio', { name: /Project roots/ }).check();
  await page.getByPlaceholder('Search top-level folders...').fill('Child folder');
  await expect(page.getByRole('button', { name: 'Add Child folder', exact: true })).toHaveCount(0);
  await page.getByPlaceholder('Search top-level folders...').fill('Browser tests');
  await page.getByRole('button', { name: 'Add Browser tests', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeEnabled();
  await expect(page.getByText('Rule includes non-private subfolders')).toBeVisible();
  await page.getByRole('radio', { name: /Specific folders/ }).check();
  await expect(page.getByText('No folders selected.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeDisabled();
});

test('initial consent allows explicit permissions beyond the app request', async ({ page }) => {
  await mockConsent(page, 'notes.read');
  let body: Record<string, unknown> | null = null;
  await page.route('**/internal/oauth/authorize/approve', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { redirectUrl: '/integrations' } });
  });
  for (const name of ['Create', 'Comment', 'Edit']) {
    const checkbox = page.getByRole('checkbox', { name, exact: true });
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).not.toBeChecked();
  }
  const folderCreation = page.getByRole('checkbox', { name: /Allow folder creation/ });
  await expect(folderCreation).toBeEnabled();
  await expect(folderCreation).not.toBeChecked();
  const read = page.getByRole('checkbox', { name: 'Read', exact: true });
  const comment = page.getByRole('checkbox', { name: 'Comment', exact: true });
  await comment.check();
  await read.uncheck();
  await expect(comment).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeDisabled();
  await comment.check();
  await expect(read).toBeChecked();
  await folderCreation.check();
  await folderCreation.uncheck();
  await folderCreation.check();
  await expect(comment).toBeChecked();
  await page.getByRole('button', { name: 'Allow access' }).click();
  await expect
    .poll(() => body)
    .toMatchObject({
      scope: 'notes.read',
      accessMode: 'all',
      canRead: true,
      canCreate: false,
      canEdit: false,
      canComment: true,
      canCreateFolders: true,
      sharedAccessMode: 'none',
      collaborationGrantIds: [],
      permissions: [],
    });
  await expect(page).toHaveURL(/\/integrations$/);
});

test('folder-creation-only consent does not grant note permissions automatically', async ({ page }) => {
  await mockConsent(page, 'folders.create');
  let body: Record<string, unknown> | null = null;
  await page.route('**/internal/oauth/authorize/approve', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { redirectUrl: '/integrations' } });
  });
  for (const name of ['Read', 'Create', 'Comment', 'Edit']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  }
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Allow folder creation/ }).check();
  await page.getByRole('button', { name: 'Allow access' }).click();
  await expect
    .poll(() => body)
    .toMatchObject({
      canRead: false,
      canCreate: false,
      canEdit: false,
      canComment: false,
      canCreateFolders: true,
    });
});

test('consent shares bulk and individual folder controls beyond requested scopes', async ({ page }) => {
  await mockConsent(page, 'notes.read');
  let body: Record<string, unknown> | null = null;
  await page.route('**/internal/oauth/authorize/approve', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ redirectUrl: '/integrations' }),
    });
  });
  await page.getByRole('radio', { name: /Specific folders/ }).check();
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeDisabled();
  await page.getByPlaceholder('Search folders...').fill('Browser tests');
  await page.getByRole('button', { name: 'Add Browser tests', exact: true }).click();
  await page.getByPlaceholder('Search folders...').fill('Child folder');
  await page.getByRole('button', { name: 'Add Child folder', exact: true }).click();
  const read = page.getByRole('checkbox', { name: 'Read', exact: true });
  const comment = page.getByRole('checkbox', { name: 'Comment', exact: true });
  await read.nth(1).uncheck();
  await comment.nth(1).check();
  await expect(read.nth(1)).toBeChecked();
  await expect(comment.first()).toHaveJSProperty('indeterminate', true);
  await comment.first().check();
  await expect(comment.nth(2)).toBeChecked();
  await comment.nth(2).uncheck();
  await page.getByRole('checkbox', { name: 'Edit', exact: true }).nth(2).check();
  await page.getByRole('checkbox', { name: /Allow folder creation/ }).check();
  await page.getByRole('button', { name: 'Allow access' }).click();
  await expect
    .poll(() => body)
    .toMatchObject({
      accessMode: 'specific',
      canRead: true,
      canComment: true,
      canEdit: true,
      canCreate: false,
      scope: 'notes.read',
      canCreateFolders: true,
      sharedAccessMode: 'none',
      collaborationGrantIds: [],
      permissions: [
        { folderId: 'folder_browser', canRead: true, canComment: true, canEdit: false, appliesTo: 'exact' },
        { folderId: 'folder_child_browser', canRead: true, canComment: false, canEdit: true, appliesTo: 'exact' },
      ],
    });
  await expect(page).toHaveURL(/\/integrations$/);
});

test('consent supports optional restrictions and displays save errors for retry', async ({ page }) => {
  await mockConsent(page, fullScope);
  await page.getByRole('checkbox', { name: 'Edit', exact: true }).check();
  await page.getByRole('checkbox', { name: /Allow folder creation/ }).check();
  await page.getByPlaceholder('Search folders...').fill('Browser tests');
  await page.getByRole('button', { name: 'Add Browser tests', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Edit', exact: true }).nth(1).uncheck();
  let body: Record<string, unknown> | null = null;
  await page.route('**/internal/oauth/authorize/approve', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Test authorization error' }),
    });
  });
  await page.getByRole('button', { name: 'Allow access' }).click();
  await expect(page.getByRole('alert')).toHaveText('Test authorization error');
  await expect(page.getByRole('button', { name: 'Allow access' })).toBeEnabled();
  expect(body).toMatchObject({
    accessMode: 'all',
    canRead: true,
    canEdit: true,
    canCreateFolders: true,
    permissions: [{ folderId: 'folder_browser', canRead: true, canEdit: false }],
  });
});
