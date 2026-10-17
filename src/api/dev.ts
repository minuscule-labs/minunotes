import { serve } from '@hono/node-server';
import app from './index';

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST;

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`API listening on http://${hostname ?? 'localhost'}:${info.port}`);
});
