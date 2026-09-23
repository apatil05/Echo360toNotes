import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The upload endpoint and Supabase auth allow exactly this origin in development.
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
