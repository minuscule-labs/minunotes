import path from 'node:path';
import mdx from '@mdx-js/rollup';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { createServer } from 'vite';
import { assertOwnedDemoDirectory, DEMO_API_PORT, DEMO_WEB_PORT, PROJECT_ROOT } from './lib/board-demo';

async function main() {
  const root = process.env.BOARD_DEMO_ROOT;
  const marker = process.env.BOARD_DEMO_MARKER;
  if (
    !root ||
    !marker ||
    process.env.ENVIRONMENT !== 'local' ||
    process.env.VITE_API_PROXY_TARGET !== `http://127.0.0.1:${DEMO_API_PORT}`
  )
    throw new Error('Start this frontend with pnpm board:demo, not standalone');
  await assertOwnedDemoDirectory(root, marker);
  // Independent cache/env directory: normal dev/test servers may coexist.
  const server = await createServer({
    root: PROJECT_ROOT,
    configFile: false,
    envFile: false,
    envDir: root,
    plugins: [mdx({ remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter] }), react(), tailwindcss()],
    resolve: {
      dedupe: [
        '@codemirror/autocomplete',
        '@codemirror/commands',
        '@codemirror/lang-css',
        '@codemirror/lang-html',
        '@codemirror/lang-javascript',
        '@codemirror/lang-json',
        '@codemirror/lang-markdown',
        '@codemirror/lang-python',
        '@codemirror/lang-sql',
        '@codemirror/lang-yaml',
        '@codemirror/language',
        '@codemirror/legacy-modes',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/highlight',
      ],
    },
    cacheDir: path.join(root, 'vite-cache'),
    server: {
      host: '127.0.0.1',
      port: DEMO_WEB_PORT,
      strictPort: true,
      proxy: { '/internal': { target: `http://127.0.0.1:${DEMO_API_PORT}`, changeOrigin: true } },
    },
  });
  try {
    await server.listen();
    server.printUrls();
  } catch (error) {
    await server.close();
    throw error;
  }
  const stop = () => {
    void server.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
