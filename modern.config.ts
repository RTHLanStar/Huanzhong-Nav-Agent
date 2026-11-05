import { appTools, defineConfig } from '@modern-js/app-tools';

export default defineConfig({
  plugins: [appTools()],
  output: {
    distPath: {
      root: 'dist',
      html: 'html',
      js: 'static/js',
      css: 'static/css',
    },
  },
  html: {
    title: '幻终の导航',
  },
  source: {
    alias: {
      '@': './src',
    },
  },
  // 开发模式把接口与运行时静态目录代理到 Node 后端（生产由 server.js 直接托管 dist）
  dev: {
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:2220', changeOrigin: false },
        '/uploads': { target: 'http://127.0.0.1:2220', changeOrigin: false },
        '/favicons': { target: 'http://127.0.0.1:2220', changeOrigin: false },
        '/files': { target: 'http://127.0.0.1:2220', changeOrigin: false },
      },
    },
  },
});
