import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nutritrace.app',
  appName: 'NutriTrace',
  webDir: 'dist',
  // In dev, point to your local Vite dev server for live-reload on device
  // Uncomment and set your machine's LAN IP when doing native dev builds:
  // server: { url: 'http://192.168.1.x:5173', cleartext: true },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#0A0B0F',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    Keyboard: {
      resize: 'native',
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0A0B0F',
    },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};

export default config;
