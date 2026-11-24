import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:18301',
    changeOrigin: false,
    xfwd: true,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 18517,
    proxy: apiProxy,
  },
  preview: {
    port: 18517,
    host: true,
    allowedHosts: true,
    proxy: apiProxy,
  },
});
