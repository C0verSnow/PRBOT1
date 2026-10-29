import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  // Codex resolves its platform package dynamically; NFT cannot infer these paths.
  outputFileTracingIncludes: { "/*": ["./node_modules/@openai/codex*/**/*"] },
  // Runtime workspace .git checks must not trace this application's Git history.
  outputFileTracingExcludes: { "/*": ["./.git", "./.git/**/*"] },
  serverExternalPackages: ["@openai/codex-sdk"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
    ] }];
  },
};
export default config;
