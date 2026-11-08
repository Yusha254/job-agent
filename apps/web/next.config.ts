import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
	async rewrites() {
		const apiOrigin = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
		return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
	},
};

export default nextConfig;