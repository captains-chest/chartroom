import { defineConfig } from 'vite-plus';

// Two entry modules served by the integration from /chartroom_static/. File names carry no hash:
// the integration adds ?v=<version> to the URLs, which is what busts caches in the companion apps.
export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: 'custom_components/chartroom/frontend',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        'chartroom-panel': 'frontend/src/chartroom-panel.ts',
        'chartroom-card': 'frontend/src/chartroom-card.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: { output: { entryFileNames: 'workers/[name].js' } },
  },
  test: {
    include: ['frontend/test/**/*.test.ts'],
    environment: 'node',
  },
  lint: {
    ignorePatterns: [
      'custom_components/chartroom/frontend/**',
      'test-results/**',
      'playwright-report/**',
    ],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    printWidth: 100,
    singleQuote: true,
    sortPackageJson: false,
    ignorePatterns: [
      'pnpm-lock.yaml',
      'custom_components/chartroom/frontend/',
      'node_modules/',
      'test-results/',
      'playwright-report/',
    ],
  },
});
