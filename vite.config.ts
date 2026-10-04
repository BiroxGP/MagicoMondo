import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// In locale (npm run dev) Vite non esegue le funzioni di /api come fa Vercel:
// questo plugin le monta nel dev server così si può provare tutto senza Vercel.
function apiDev(): Plugin {
  return {
    name: 'api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
        try {
          const mod = await server.ssrLoadModule(`/api/${name}.js`);
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: any = undefined;
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              body = raw;
            }
          }
          const query: Record<string, string> = {};
          url.searchParams.forEach((v, k) => {
            query[k] = v;
          });
          const r: any = req;
          r.body = body;
          r.query = query;
          const s: any = res;
          s.status = (code: number) => {
            res.statusCode = code;
            return s;
          };
          s.json = (obj: unknown) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(obj));
          };
          await mod.default(r, s);
        } catch (e) {
          console.error(e);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'dev_api_error' }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiDev()],
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
});
