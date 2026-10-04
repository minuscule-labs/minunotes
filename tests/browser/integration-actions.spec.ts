import { expect, type Page, test } from '@playwright/test';
import type { ApiKey } from '../../src/frontend/lib/api';
import { mockBrowserApi } from './fixtures';

const now = '2026-10-04T00:00:00.000Z';
const apiKey: ApiKey = {
  id: 'key_actions',
  name: 'Menu key',
  uid: 'uid_menu_key',
  accessMode: 'all',
  sharedAccessMode: 'none',
  collaborationGrantIds: [],
  canRead: true,
  canCreate: false,
  canComment: false,
  canEdit: false,
  canCreateFolders: false,
  permissions: [],
  createdAt: now,
  revokedAt: null,
  lastUsedAt: null,
};
async function mockKey(page: Page, key: ApiKey) {
  await mockBrowserApi(page);
  let update: Record<string, unknown> | null = null;
  const deletes: string[] = [];
  await page.route('**/internal/api-keys**', (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      update = request.postDataJSON();
      Object.assign(key, update);
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === 'DELETE') {
      deletes.push(new URL(request.url()).pathname);
      key.revokedAt = now;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { keys: [key] } });
  });
  await page.route('**/internal/oauth/clients', (route) => route.fulfill({ json: { clients: [] } }));
  await page.route('**/internal/oauth/authorizations', (route) => route.fulfill({ json: { authorizations: [] } }));
  return { update: () => update, deletes };
}

test('API-key row actions are menu-only and editing survives closing the popup', async ({ page }) => {
  const state = await mockKey(page, { ...apiKey });
  await page.goto('/integrations');
  const trigger = page.getByRole('button', { name: 'Actions for API key Menu key', exact: true });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit access', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke key', exact: true })).toHaveCount(0);
  await trigger.click();
  await page.getByRole('button', { name: 'Edit access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit API key', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke key', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Create', exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit API key', exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.update()).toMatchObject({ name: 'Menu key', canRead: true, canCreate: true });
  await trigger.click();
  await page.getByRole('button', { name: 'Edit access', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Create', exact: true })).toBeChecked();
});

test('API-key revocation keeps confirmation and returns focus to its menu trigger', async ({ page }) => {
  const state = await mockKey(page, { ...apiKey });
  await page.goto('/integrations');
  const trigger = page.getByRole('button', { name: 'Actions for API key Menu key', exact: true });
  await trigger.click();
  await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Revoke API key?' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Revoke key', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.deletes).toHaveLength(0);
  await trigger.click();
  await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Type delete to confirm API key' }).fill('delete');
  await dialog.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.deletes).toEqual(['/internal/api-keys/key_actions']);
  await trigger.click();
  await expect(page.getByRole('button', { name: 'Edit access', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke key', exact: true })).toHaveCount(0);
  await expect(page.getByText('Revoked · uid_menu_key', { exact: true })).toBeVisible();
});

test('API-key action menu is keyboard-accessible on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockKey(page, { ...apiKey });
  await page.goto('/integrations');
  const trigger = page.getByRole('button', { name: 'Actions for API key Menu key', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Edit access', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
