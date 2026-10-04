import { expect, type Page, test } from '@playwright/test';
import type { OAuthAuthorization, OAuthClient } from '../../src/frontend/lib/api';
import { mockBrowserApi } from './fixtures';

const now = '2026-10-04T00:00:00.000Z';
const client: OAuthClient = {
  id: 'client_owned',
  userId: 'user_browser',
  name: 'Owned app',
  description: null,
  redirectUris: '["https://client.example/callback"]',
  clientType: 'public',
  createdAt: now,
  updatedAt: now,
  revokedAt: null,
};
function authorization(id: string, app = client, overrides: Partial<OAuthAuthorization> = {}): OAuthAuthorization {
  return {
    id,
    clientId: app.id,
    client: app,
    userId: 'user_browser',
    scope: 'notes.read',
    accessMode: 'all',
    sharedAccessMode: 'none',
    collaborationGrantIds: [],
    canRead: true,
    canCreate: false,
    canEdit: false,
    canComment: false,
    canCreateFolders: false,
    permissions: [],
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}
async function mockApps(page: Page, clients: OAuthClient[], authorizations: OAuthAuthorization[]) {
  await mockBrowserApi(page);
  const deletes: string[] = [];
  const gets = { clients: 0, authorizations: 0 };
  await page.route('**/internal/oauth/clients**', (route) => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      deletes.push(new URL(request.url()).pathname);
      const id = new URL(request.url()).pathname.split('/').at(-1);
      const app = clients.find((entry) => entry.id === id);
      if (app) app.revokedAt = now;
      for (const connection of authorizations) if (connection.clientId === id) connection.revokedAt = now;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    gets.clients += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clients }) });
  });
  await page.route('**/internal/oauth/authorizations**', (route) => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      deletes.push(new URL(request.url()).pathname);
      const id = new URL(request.url()).pathname.split('/').at(-1);
      const connection = authorizations.find((entry) => entry.id === id);
      if (connection) connection.revokedAt = now;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    gets.authorizations += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizations }) });
  });
  return { deletes, gets };
}

test('unifies registered, external connected, and revoked apps without duplicate names', async ({ page }) => {
  const external = { ...client, id: 'client_external', userId: null, name: 'External app' };
  const revoked = { ...client, id: 'client_revoked', name: 'Old app', revokedAt: now };
  await mockApps(page, [{ ...client }, revoked], [authorization('external_connection', external)]);
  await page.goto('/integrations');
  const rows = page.getByTestId('oauth-app-row');
  await expect(rows).toHaveCount(3);
  const registeredRow = rows.filter({ hasText: 'Owned app' });
  await expect(registeredRow.getByText('Registered', { exact: true })).toBeVisible();
  await expect(registeredRow.getByText('Not connected', { exact: true })).toBeVisible();
  const connectedRow = rows.filter({ hasText: 'External app' });
  await expect(connectedRow.getByText('Connected', { exact: true })).toBeVisible();
  await expect(connectedRow.getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit access' })).toHaveCount(0);
  await connectedRow.getByRole('button', { name: 'App details and actions for External app' }).click();
  await expect(page.getByRole('button', { name: 'Edit access' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke app', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const revokedRow = rows.filter({ hasText: 'Old app' });
  await expect(revokedRow.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(revokedRow.getByRole('button', { name: 'Edit access' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Connected apps', exact: true })).toHaveCount(0);
});

test('disconnect only revokes the selected connection and preserves its app registration', async ({ page }) => {
  const state = await mockApps(page, [{ ...client }], [authorization('connection_single')]);
  await page.goto('/integrations');
  const row = page.getByTestId('oauth-app-row');
  await row.getByRole('button', { name: 'App details and actions for Owned app' }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Disconnect app?' })).toBeVisible();
  await expect(dialog).toContainText('app registration and other connections are unchanged');
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
  expect(state.deletes).toEqual(['/internal/oauth/authorizations/connection_single']);
  await row.getByRole('button', { name: 'App details and actions for Owned app' }).click();
  await expect(page.getByRole('button', { name: 'Revoke app', exact: true })).toBeVisible();
});

test('app-registration revocation refreshes both registrations and connections', async ({ page }) => {
  const state = await mockApps(page, [{ ...client }], [authorization('connection_single')]);
  await page.goto('/integrations');
  const row = page.getByTestId('oauth-app-row');
  await row.getByRole('button', { name: 'App details and actions for Owned app' }).click();
  await page.getByRole('button', { name: 'Revoke app', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Revoke app registration?' })).toBeVisible();
  await expect(dialog).toContainText('all of its connections');
  await expect(dialog.getByRole('button', { name: 'Revoke app', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Type delete to confirm app registration' }).fill('delete');
  await dialog.getByRole('button', { name: 'Revoke app', exact: true }).click();
  await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Edit access' })).toHaveCount(0);
  expect(state.deletes).toEqual(['/internal/oauth/clients/client_owned']);
  expect(state.gets.clients).toBeGreaterThanOrEqual(2);
  expect(state.gets.authorizations).toBeGreaterThanOrEqual(2);
});

test('groups every authorization and targets the chosen connection independently', async ({ page }) => {
  const state = await mockApps(
    page,
    [{ ...client }],
    [
      authorization('connection_first'),
      authorization('connection_second', client, { canEdit: true }),
      authorization('connection_old', client, { revokedAt: now }),
    ]
  );
  await page.goto('/integrations');
  const row = page.getByTestId('oauth-app-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByText('2 active · 3 total connections')).toBeVisible();
  await row.locator('summary').click();
  const connections = page.getByTestId('oauth-connection-row');
  await expect(connections).toHaveCount(3);
  await connections.nth(2).getByRole('button', { name: 'Actions for connection connection_old' }).click();
  await expect(page.getByRole('button', { name: 'Edit access' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await connections.nth(1).getByRole('button', { name: 'Actions for connection connection_second' }).click();
  await page.getByRole('button', { name: 'Edit access' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Owned app access' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Edit', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Close connected app access' }).click();
  await expect(
    connections.nth(1).getByRole('button', { name: 'Actions for connection connection_second' })
  ).toBeFocused();
  await connections.nth(1).getByRole('button', { name: 'Actions for connection connection_second' }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(row.getByText('1 active · 3 total connections')).toBeVisible();
  expect(state.deletes).toEqual(['/internal/oauth/authorizations/connection_second']);
  await connections.nth(0).getByRole('button', { name: 'Actions for connection connection_first' }).click();
  await expect(page.getByRole('button', { name: 'Edit access' })).toBeVisible();
});

test('copies the exact client ID from an app action popup', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApps(page, [{ ...client }], [authorization('connection_single')]);
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'App details and actions for Owned app' }).click();
  await page.getByRole('button', { name: 'Copy client ID', exact: true }).click();
  await expect(page.getByText('Client ID copied.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(client.id);
  await expect(page.getByRole('button', { name: 'Copy client ID', exact: true })).toHaveText('Copy client ID');
});

test('failed clipboard access offers manual copying without closing the popup', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: () => Promise.reject(new Error('Clipboard denied')),
    });
  });
  await mockApps(page, [{ ...client }], []);
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'App details and actions for Owned app' }).click();
  await page.getByRole('button', { name: 'Copy client ID', exact: true }).click();
  await expect(page.getByText('Unable to copy. Select and copy the client ID above.', { exact: true })).toBeVisible();
  await expect(page.getByText(client.id, { exact: true })).toBeVisible();
});

test('copies the client ID immediately after creating an app', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApps(page, [], []);
  await page.route('**/internal/oauth/clients', (route) => {
    return route.fulfill({ json: route.request().method() === 'POST' ? { client } : { clients: [] } });
  });
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Add App', exact: true }).click();
  await page.getByRole('button', { name: /Custom app/ }).click();
  await page.getByRole('textbox', { name: 'App name', exact: true }).fill('Owned app');
  await page.getByRole('textbox', { name: /Redirect URI/ }).fill('https://client.example/callback');
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(page.getByText('App created', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy client ID', exact: true }).click();
  await expect(page.getByText('Client ID copied.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(client.id);
});

test('empty state keeps Add App available', async ({ page }) => {
  await mockApps(page, [], []);
  await page.goto('/integrations');
  await expect(page.getByText('No apps yet.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add App', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add app', exact: true })).toBeVisible();
});

test('query failures do not mislabel connected apps as Registered and can be retried', async ({ page }) => {
  await mockApps(page, [{ ...client }], [authorization('connection_single')]);
  let failing = true;
  await page.route('**/internal/oauth/authorizations', (route) =>
    route.fulfill({
      status: failing ? 500 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        failing ? { error: 'Unavailable' } : { authorizations: [authorization('connection_single')] }
      ),
    })
  );
  await page.goto('/integrations');
  await expect(page.getByRole('alert')).toContainText('Registration and connection status could not be confirmed', {
    timeout: 15000,
  });
  await expect(page.getByTestId('oauth-app-row')).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('oauth-app-row').getByText('Connected', { exact: true })).toBeVisible();
});

test('waits for both queries before assigning an app status', async ({ page }) => {
  await mockApps(page, [{ ...client }], [authorization('connection_single')]);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/internal/oauth/authorizations', async (route) => {
    await pending;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authorizations: [authorization('connection_single')] }),
    });
  });
  await page.goto('/integrations');
  await expect(page.getByText('Loading apps...', { exact: true })).toBeVisible();
  await expect(page.getByTestId('oauth-app-row')).toHaveCount(0);
  release();
  await expect(page.getByTestId('oauth-app-row').getByText('Connected', { exact: true })).toBeVisible();
});

test('unified app row fits a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApps(page, [{ ...client }], [authorization('connection_single')]);
  await page.goto('/integrations');
  await page
    .getByTestId('oauth-app-row')
    .getByRole('button', { name: 'App details and actions for Owned app' })
    .click();
  await expect(page.getByRole('button', { name: 'Edit access' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
