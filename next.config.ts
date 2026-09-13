import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 只給 Docker 用（Dockerfile 會設 BUILD_STANDALONE=1）。
  // 本機若一律開啟，`next start` 會警告與 standalone 不相容。
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
