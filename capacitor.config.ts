import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wheelgrade.app',
  appName: 'WheelGrade',
  webDir: 'web',
  backgroundColor: '#ffffff',
  server: {
    // Load the live PWA so App Store builds never go stale when the
    // Worker deploys a web change. The bundled web/ snapshot is only a
    // fallback; the app always opens the live site.
    url: 'https://wheelgrade.com/app/',
    cleartext: false,
  },
  ios: {
    // Keep the WKWebView content inset normal; the web app handles its
    // own safe-area via viewport-fit=cover.
    contentInset: 'always',
  },
};

export default config;
