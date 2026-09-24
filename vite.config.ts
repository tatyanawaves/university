import { defineConfig } from 'vite';

export default defineConfig({
    // "/" for Vercel or a domain of its own; "/university/" on GitHub Pages (set by the workflow).
    base: process.env.BASE_PATH ?? '/',
    server: { port: 3000, host: '0.0.0.0' },
});
