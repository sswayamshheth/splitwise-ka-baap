/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // The Digital Twin reads its recorded real-data capture (Judge demo mode, geocode/place fallback)
    // from data/replay at runtime; make sure Vercel bundles it with the functions that read it.
    outputFileTracingIncludes: {
      "/api/trips/[id]/twin": ["./data/replay/**/*"],
      "/api/trips/[id]/twin/explain": ["./data/replay/**/*"],
      "/api/trips/[id]/twin/scenario": ["./data/replay/**/*"],
      "/api/trips/[id]": ["./data/replay/**/*"],
    },
  },
};

export default nextConfig;
