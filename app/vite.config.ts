import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// In development, serve the demo prototype (../frontend) at /demo/ like the production build does.
const DEMO_DIR = fileURLToPath(new URL('../frontend', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function serveDemo(): Plugin {
  return {
    name: 'lumaco-serve-demo',
    configureServer(server) {
      server.middlewares.use('/demo', (req, res, next) => {
        // "/demo" needs the trailing slash so the demo's relative links (./styles/...) resolve.
        const original = (req as { originalUrl?: string }).originalUrl ?? '';
        if (original.split('?')[0] === '/demo') { res.statusCode = 301; res.setHeader('Location', '/demo/'); res.end(); return; }
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const file = normalize(join(DEMO_DIR, path.endsWith('/') ? path + 'index.html' : path));
        if (!file.startsWith(DEMO_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveDemo()],
  server: { port: 5173, strictPort: false },
  build: { outDir: 'dist', sourcemap: true },
});
