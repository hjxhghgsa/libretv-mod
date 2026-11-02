import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const nextConfig: NextConfig = {
  // ★ 关掉 webpack profile：它会往 <distDir>/trace 写性能追踪文件，
  // 而这个环境的文件钩子对名为 trace 的写入一律 EPERM → 构建直接失败。
  // 与功能无关，纯环境限制。
  webpack: (config) => {
    // ★ webpack 5 的 profile 会往 <distDir>/trace 写性能追踪文件。
    //   这个环境的文件钩子对 trace 的写入和删除都报 EPERM，
    //   导致 next build 反复失败（删不掉旧的 → 写不进新的）。
    //   两端都关掉，与功能无关，纯环境限制。
    config.profile = false;
    config.infrastructureLogging = { level: 'error' };
    return config;
  },
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  env: { APP_VERSION: readAppVersion() },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
};

export default nextConfig;
