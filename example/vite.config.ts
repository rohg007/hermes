import path from 'node:path';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const reactNativeWeb = path.dirname(require.resolve('react-native-web/package.json'));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'react-native': reactNativeWeb,
      '@bitnet/react-native': path.join(root, 'src/index.ts'),
    },
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.jsx', '.js', '.json'],
  },
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    fs: {
      allow: [root, __dirname],
    },
  },
});
