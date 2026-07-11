import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/ewwt/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '地震気象防災アプリ',
        short_name: 'ewwt', // お好みの名前に変更してください
        description: '地震・気象・防災情報アプリ',
        theme_color: '#0B0B0C',
        background_color: '#0B0B0C',
        display: 'standalone',
        start_url: '/ewwt/',
        scope: '/ewwt/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // P2P地震情報APIなど外部APIへのfetchはキャッシュしない。
        // 地震情報はリアルタイム性が命なので、Service Workerが古いキャッシュを
        // 返して「新しい地震が来たのに古い情報が表示され続ける」事態を避ける。
        runtimeCaching: [],
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
})
