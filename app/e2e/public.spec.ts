import { expect, test } from '@playwright/test';
import { mockSupabase } from './mock';

test.beforeEach(async ({ page }) => { await mockSupabase(page); });

test('sign-in page links to the privacy policy and terms', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.goto('/signup');
  await page.getByRole('link', { name: 'Privacy Policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible();
  await expect(page.getByText('Google API Services User Data Policy', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Limited Use requirements/)).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Terms' }).click();
  await expect(page.getByRole('heading', { name: 'Terms of Service', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recording and consent' })).toBeVisible();
});

test('legal pages are public and fit a phone screen', async ({ page }) => {
  for (const path of ['/privacy', '/terms']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test('signed-out visitors are sent to sign in', async ({ page }) => {
  await page.goto('/app/contacts');
  await expect(page).toHaveURL(/\/signin$/);
});

test('sign-in page confirms a deleted account', async ({ page }) => {
  await page.goto('/signin?deleted=1');
  await expect(page.getByRole('status').filter({ hasText: 'Your account and data have been deleted.' })).toBeVisible();
});
