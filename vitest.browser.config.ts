import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const configuredChrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = configuredChrome || (existsSync(macChrome) ? macChrome : undefined);

export default defineConfig({
  test: {
    include: ['src/**/*.browser.test.ts'],
    exclude: ['**/.claude/**'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [
        {
          browser: 'chromium',
          launch: {
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          },
        },
      ],
    },
  },
});
