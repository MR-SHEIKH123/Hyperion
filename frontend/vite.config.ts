import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendTarget = process.env.HYPERION_BACKEND_URL ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', port: 4318, strictPort: true,
    allowedHosts: true,
    proxy: { '/api': { target: backendTarget, changeOrigin: false } },
  },
  preview: {
    host: '0.0.0.0', port: 4318, strictPort: true,
    allowedHosts: true,
  },
});
