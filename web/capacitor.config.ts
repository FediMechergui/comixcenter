import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.comixcenter",
  appName: "ComixCenter",
  webDir: "out",
  android: {
    // The app talks to your ComixCenter server over plain HTTP on the local network
    allowMixedContent: true,
  },
  server: {
    // Served as http://localhost: still a secure context (Cache Storage works), and it avoids
    // Chromium auto-upgrading <img> requests to the plain-HTTP server into failing HTTPS ones.
    androidScheme: "http",
    cleartext: true,
  },
};

export default config;
