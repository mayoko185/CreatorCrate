import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const browserEntry = fileURLToPath(new URL('./client/main.js', import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist/client',
    manifest: true,
    emptyOutDir: true,
    rolldownOptions: {
      input: browserEntry,
    },
  },
});
