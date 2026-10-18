import mdx from '@mdx-js/rollup';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

async function getSstApiUrl() {
  try {
    const { Resource } = await import('sst');
    return (
      (Resource as { ApiGateway?: { url?: string }; Api?: { url?: string } }).ApiGateway?.url ??
      (Resource as { Api?: { url?: string } }).Api?.url
    );
  } catch {
    return undefined;
  }
}

export default defineConfig(async ({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiTarget = env.VITE_API_PROXY_TARGET || (await getSstApiUrl());

  console.log(`[vite] Proxy target: ${apiTarget}`);

  return {
    plugins: [mdx({ remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter] }), react(), tailwindcss()],
    test: {
      // Demo lifecycle tests bind ports and start real servers; run with test:demo instead.
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.{git,cache,output,temp}/**',
        'tests/browser/**',
        'tests/demo/**',
      ],
    },
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
    server: {
      proxy:
        apiTarget && apiTarget !== '/internal'
          ? {
              '/internal': {
                target: apiTarget.replace(/\/$/, ''),
                changeOrigin: true,
                secure: true,
              },
            }
          : undefined,
    },
  };
});
