import type { ExpoConfig } from 'expo/config';

/** Host of the public website; shared product links on this host open in the app (Android App Links). */
const appLinkHost = process.env.APP_LINK_HOST ?? 'sriananthacart.in';

const config: ExpoConfig = {
  name: 'Sri Anantha Cart',
  slug: 'sri-anantha-cart',
  scheme: 'sriananthacart',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  icon: './assets/icon.png',
  backgroundColor: '#fefcf7',
  android: {
    package: 'in.sriananthacart.app',
    versionCode: 1,
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#fdf8f0' },
    // Location is asked for only when the customer taps "Use my current location" (foreground only).
    permissions: ['android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION'],
    blockedPermissions: ['android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.RECORD_AUDIO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW'],
    intentFilters: [{
      action: 'VIEW',
      autoVerify: true,
      data: [
        { scheme: 'https', host: appLinkHost, pathPrefix: '/products/' },
        { scheme: 'https', host: appLinkHost, pathPrefix: '/c/' },
        { scheme: 'https', host: appLinkHost, pathPrefix: '/account/orders/' },
      ],
      category: ['BROWSABLE', 'DEFAULT'],
    }],
  },
  plugins: [
    'expo-secure-store',
    'expo-web-browser',
    'expo-font',
    ['expo-local-authentication', { faceIDPermission: 'Use biometrics to unlock Sri Anantha Cart' }],
    ['expo-location', { locationWhenInUsePermission: 'Sri Anantha Cart uses your location to fill in your delivery address and check delivery to your area.', isAndroidBackgroundLocationEnabled: false }],
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 240, resizeMode: 'contain', backgroundColor: '#fefcf7' }],
  ],
  web: { bundler: 'metro' },
};

export default config;
