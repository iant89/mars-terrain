import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function getAppCommit() {
  const suppliedCommit = process.env.GITHUB_SHA || process.env.VITE_APP_COMMIT;
  if (suppliedCommit && /^[a-f0-9]{7,40}$/i.test(suppliedCommit)) return suppliedCommit;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  define: {
    __APP_COMMIT__: JSON.stringify(getAppCommit()),
  },
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
