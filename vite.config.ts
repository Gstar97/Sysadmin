import path from 'node:path'
import mdx from '@mdx-js/rollup'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import { defineConfig } from 'vite'
import { contentPlugin } from './build/content-plugin'
import { yamlPlugin } from './build/yaml-plugin'

// CONTENT_DIR permite usar otra carpeta de contenido (por ejemplo, la de pruebas).
const contentDir = path.resolve(process.env.CONTENT_DIR ?? 'content')

export default defineConfig({
  plugins: [
    yamlPlugin(),
    contentPlugin({ contentDir }),
    {
      enforce: 'pre',
      ...mdx({
        remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm],
      }),
    },
    react({ include: /\.(mdx|jsx|tsx|ts|js)$/ }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@content': contentDir,
      '@': path.resolve('src'),
    },
  },
  server: {
    fs: { allow: [contentDir, path.resolve('.')] },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
})
