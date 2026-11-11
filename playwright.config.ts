import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  // Every test launches the real app, and all instances share one database
  // file, so test files must not run side by side.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list'
})
