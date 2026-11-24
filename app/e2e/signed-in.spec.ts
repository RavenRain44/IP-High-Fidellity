import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { mockSupabase, type Backend } from './mock';

let be: Backend;
test.beforeEach(async ({ page }) => { be = await mockSupabase(page, { signedIn: true }); });

test('dashboard opens for a signed-in user', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator('h1').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('contacts list shows the people from the database', async ({ page }) => {
  await page.goto('/app/contacts');
  await expect(page.getByText('Sarah Mitchell').first()).toBeVisible();
  await expect(page.getByText('Dan Ortiz').first()).toBeVisible();
});

test('team owners see the Team Dashboard with shared records', async ({ page }) => {
  await page.goto('/app/team');
  await expect(page.getByRole('heading', { name: 'Team Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByText('Sarah Mitchell needs outreach')).toBeVisible();
  await expect(page.getByText('Send revised drawings')).toBeVisible();
});

test('download my data saves a JSON export', async ({ page }) => {
  await page.goto('/app/account');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download my data' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^lumaco-export-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(data.contacts[0].full_name).toBe('Sarah Mitchell');
  expect(be.calls.some(c => c.kind === 'rpc' && c.name === 'export_my_data')).toBe(true);
});

test('deleting the account needs DELETE typed, explains team hand-over, then signs out', async ({ page }) => {
  await page.goto('/app/account');
  await page.getByRole('button', { name: 'Delete my account…' }).click();
  await expect(page.getByText('Sam Member becomes owner.')).toBeVisible();
  await expect(page.getByText(/2 shared records .* pass to Sam Member/)).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Permanently delete account' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('delete');
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await confirm.click();
  await expect(page).toHaveURL(/\/signin\?deleted=1$/);
  await expect(page.getByText('Your account and data have been deleted.')).toBeVisible();
  const call = be.calls.find(c => c.kind === 'function' && c.name === 'account-delete');
  expect(call?.body).toEqual({ confirm: 'DELETE' });
});

test('a failed deletion keeps you signed in and explains', async ({ page }) => {
  be.functions['account-delete'] = () => ({ status: 500, body: { error: 'Your account couldn’t be deleted completely. Please try again in a minute.' } });
  await page.goto('/app/account');
  await page.getByRole('button', { name: 'Delete my account…' }).click();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Permanently delete account' }).click();
  await expect(page.getByRole('alert')).toContainText('couldn’t be deleted');
  await expect(page).toHaveURL(/\/app\/account$/);
});
