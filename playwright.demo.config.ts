import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  testMatch: '**/board-demo.spec.ts',
  testIgnore: [],
  use: { ...baseConfig.use, baseURL: 'http://127.0.0.1:5181' },
  // The spec owns the disposable demo API/frontend and their teardown.
  webServer: undefined,
});
