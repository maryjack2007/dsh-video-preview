/**
 * Shared harness: runs the bundle's Host route on a real HTTP server over the
 * real filesystem, with a fake Cordis context and a controllable admission check.
 */
import { createServer } from 'node:http';
import { open, stat } from 'node:fs/promises';
import { apply } from '../dsh-video-preview/index.js';

/**
 * Start the route on an ephemeral loopback port.
 * @param options - `admit` decides admission from request headers (default: cookie `session=ok`).
 * @returns the route base URL and a close function.
 */
export async function startRoute(options = {}) {
	const admit = options.admit ?? ((headers) => headers.cookie === 'session=ok');
	let captured;
	const ctx = {
		effect(fn) {
			fn();
		},
		webServer: {
			register(route) {
				captured = route;
				return () => {};
			}
		},
		fs: {
			async resolve(path) {
				return { targetKey: path, displayPath: path };
			},
			async stat(target) {
				try {
					const info = await stat(target.targetKey);
					return { version: 'v1', type: info.isFile() ? 'file' : 'directory', size: info.size };
				} catch {
					return undefined;
				}
			},
			async readByteRange(target, { offset, length }) {
				if (options.readFailure === true) throw new Error('simulated backend read failure');
				const handle = await open(target.targetKey, 'r');
				try {
					const buffer = Buffer.alloc(length);
					const { bytesRead } = await handle.read(buffer, 0, length, offset);
					return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
				} finally {
					await handle.close();
				}
			}
		},
		connection: {
			requestRejection({ headers }) {
				return admit(headers) ? undefined : 401;
			}
		}
	};
	apply(ctx, {});
	if (captured?.path !== '/dsh-media/video') throw new Error(`route path was ${captured?.path}`);
	const server = createServer((req, res) => {
		void captured.handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}/dsh-media/video`;
	return {
		base,
		/** The route URL for one file path. */
		url: (path) => `${base}?path=${encodeURIComponent(path)}`,
		close: () => new Promise((resolve) => server.close(resolve))
	};
}
