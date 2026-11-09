import { defineConfig, passthroughImageService } from "astro/config";

// A Cobra coded site: static files only. Cobra's
// site Worker serves them and answers /api/*; nothing here runs on a server.
export default defineConfig({
  // The site's address, from Cobra's build (canonical links, Open Graph); none on a local build.
  site: process.env.COBRA_SITE_URL || undefined,
  output: "static",
  trailingSlash: "always",
  // No sharp: the install runs with --ignore-scripts. Images go in public/images/ ready-sized.
  image: { service: passthroughImageService() },
  telemetry: false,
});
