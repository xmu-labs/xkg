import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "xkg",
    short_name: "xkg",
    description: "A knowledge graph for your AI workers",
    start_url: "/",
    scope: "/",
    id: "/",
    display: "standalone",
    lang: "en",
    background_color: "#11131A",
    theme_color: "#11131A",
    icons: [
      {
        src: "/icon-192-dark.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512-dark.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // The saddle is wide, so this copy keeps it inside the 80% maskable safe zone.
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
