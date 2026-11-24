// Browser tests: npm run test:e2e
// The app runs against a fake Supabase (e2e/mock.ts), so no real accounts or data are touched.
import { defineConfig, devices } from '@playwright/test';

const PORT = 5179;
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Firefox'] } },
    { name: 'mobile', use: { browserName: 'firefox', viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/signin`,
    reuseExistingServer: false,
    // Real env values in .env.local are overridden: the app talks only to the mock.
    env: { VITE_SUPABASE_URL: 'https://mock.supabase.test', VITE_SUPABASE_ANON_KEY: 'test-anon-key' },
  },
});
