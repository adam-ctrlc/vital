import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Emits /version.json, so an open browser tab can tell a newer build has been deployed. */
function versionManifest(): Plugin {
  return {
    name: 'vital-version-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionManifest()],
  define: {
    // The bundle's own version. A live update carries its own copy, so this always names
    // the code that is actually running.
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { host: true, port: 5173 },
});
