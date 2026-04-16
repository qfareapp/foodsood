const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || './google-services.json';

module.exports = {
  expo: {
    name: 'NeighbourBites Chef',
    slug: 'foodsood-chef',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    icon: './assets/chef-icon.png',
    splash: {
      resizeMode: 'contain',
      backgroundColor: '#2D9B6F',
    },
    ios: {
      supportsTablet: false,
    },
    android: {
      googleServicesFile,
      adaptiveIcon: {
        foregroundImage: './assets/chef-adaptive-foreground.png',
        backgroundImage: './assets/chef-adaptive-background.png',
        monochromeImage: './assets/chef-adaptive-monochrome.png',
        backgroundColor: '#2D9B6F',
      },
      predictiveBackGestureEnabled: false,
      package: 'com.mepranjal.foodsoodchef',
    },
    web: {},
    extra: {
      eas: {
        projectId: '0831a9f2-5277-4065-a175-b4a949fd1009',
      },
    },
  },
};
