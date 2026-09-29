/**
 * Host half of the video preview bundle.
 *
 * The document preview renders a `<video>` element, so the browser owns
 * fetching, buffering, and seeking. That needs an HTTP URL it can range-request,
 * and this half provides exactly one: a route that streams a media file's bytes
 * with `Range` support. A large video therefore starts playing without being
 * read whole into memory, and seeking reads only the requested window instead of
 * the file again.
 *
 * Reads go through the composed filesystem (`ctx.fs`), the same read authority
 * the `workspaceFiles` Remote uses, so a remote or sandboxed backend works too.
 * The route is admitted by the browser-connection carrier
 * (`ctx.connection.requestRejection`): a loopback or configured trusted
 * authority plus the signed browser cookie. An unauthenticated or cross-site
 * request is refused before any path is resolved, so this route adds no new
 * reader of local files.
 */

/** The one route this bundle owns. Registered exact, so it never shadows the SPA fallback. */
const ROUTE_PATH = '/dsh-media/video';

/** Bytes held in memory per read while streaming; also the smallest range this route serves. */
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/**
 * Suffix to media type for the formats a browser `<video>` element can decode.
 *
 * A format belongs here only when the browser can actually play it: claiming a
 * suffix (mkv, avi, wmv, flv) the player cannot decode would replace the preview's
 * honest "cannot preview" state with an element that always fails. Those stay
 * unclaimed and keep their existing empty state.
 */
const MEDIA_TYPES = new Map([
	['mp4', 'video/mp4'],
	['m4v', 'video/mp4'],
	['webm', 'video/webm'],
	['mov', 'video/quicktime'],
	['ogv', 'video/ogg'],
	['ogg', 'video/ogg']
]);

/**
 * The media type for a path's final suffix.
 * @param path - file path or filename.
 * @returns the media type, or undefined when the suffix is not an offered one.
 */
function mediaTypeOf(path) {
	const normalized = path.replaceAll('\\', '/');
	const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
	const dot = name.lastIndexOf('.');
	if (dot < 0) return undefined;
	return MEDIA_TYPES.get(name.slice(dot + 1));
}

/**
 * Whether a path is absolute, so resolving it cannot depend on a process cwd.
 * @param path - the caller-supplied path.
 * @returns true for POSIX, drive-lettered, and UNC absolute forms.
 */
function isAbsolutePath(path) {
	return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Parse one single-range `Range` header.
 * @param header - the raw header value.
 * @param size - the complete file size in bytes.
 * @returns the inclusive window, `undefined` when there is no usable range, or
 * `null` when the range is unsatisfiable and the caller must answer 416.
 */
function parseRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return undefined;
	const [, rawStart, rawEnd] = match;
	if (rawStart === '' && rawEnd === '') return undefined;
	let start;
	let end;
	if (rawStart === '') {
		const suffix = Number(rawEnd);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
	}
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
	if (start > end || start >= size) return null;
	return { start, end };
}

/**
 * Answer a request with a status and no body.
 * @param res - the response to own.
 * @param status - HTTP status to send.
 * @param headers - extra response headers.
 * @param message - short body, omitted for a HEAD request by node:http.
 */
function sendStatus(res, status, headers, message) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(status, { 'cache-control': 'no-store', ...headers });
	res.end(message ?? '');
}

/**
 * Write one chunk, waiting for drain while honouring a closed socket.
 * @param res - the response to write to.
 * @param chunk - bytes to write.
 * @returns false when the connection closed and streaming must stop.
 */
function writeChunk(res, chunk) {
	if (res.destroyed) return Promise.resolve(false);
	if (res.write(chunk)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const settle = (writable) => {
			res.off('drain', onDrain);
			res.off('close', onClose);
			resolve(writable);
		};
		const onDrain = () => settle(true);
		const onClose = () => settle(false);
		res.once('drain', onDrain);
		res.once('close', onClose);
	});
}

/**
 * The route handler: admit, resolve, then stream the requested window.
 * @param ctx - Host context carrying the filesystem and the connection carrier.
 * @param chunkBytes - bytes per read while streaming.
 * @param req - the incoming request.
 * @param res - the response this handler owns.
 */
async function handle(ctx, chunkBytes, req, res) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		sendStatus(res, 405, { allow: 'GET, HEAD' }, 'method not allowed');
		return;
	}
	// Admission first: nothing below touches the filesystem for a refused request.
	const rejection = ctx.connection.requestRejection({ headers: req.headers });
	if (rejection !== undefined) {
		sendStatus(res, rejection, undefined, rejection === 401 ? 'unauthorized' : 'forbidden');
		return;
	}

	const url = new URL(req.url ?? '/', 'http://dsh.invalid');
	const path = url.searchParams.get('path');
	if (path === null || path === '') {
		sendStatus(res, 400, undefined, 'missing path');
		return;
	}
	// An absolute path only: resolving a relative one would depend on a cwd the
	// caller cannot see.
	if (!isAbsolutePath(path)) {
		sendStatus(res, 400, undefined, 'path must be absolute');
		return;
	}
	const type = mediaTypeOf(path);
	if (type === undefined) {
		sendStatus(res, 415, undefined, 'unsupported media type');
		return;
	}

	const target = await ctx.fs.resolve(path);
	const info = await ctx.fs.stat(target);
	if (info === undefined || info.type !== 'file') {
		sendStatus(res, 404, undefined, 'not a regular file');
		return;
	}

	const size = info.size;
	const requested = typeof req.headers.range === 'string' ? parseRange(req.headers.range, size ?? Number.MAX_SAFE_INTEGER) : undefined;
	if (requested === null) {
		sendStatus(res, 416, { 'content-range': `bytes */${size ?? '*'}` }, 'range not satisfiable');
		return;
	}

	// Only a known size can answer a range; without one the response is a plain
	// 200 stream and the browser plays it without seeking.
	const ranged = requested !== undefined && size !== undefined;
	const start = ranged ? requested.start : 0;
	const end = ranged ? requested.end : size === undefined ? Number.POSITIVE_INFINITY : size - 1;
	const total = ranged ? end - start + 1 : size;

	const headers = {
		'content-type': type,
		'accept-ranges': size === undefined ? 'none' : 'bytes',
		'cache-control': 'no-store'
	};
	if (total !== undefined) headers['content-length'] = String(total);
	if (ranged) headers['content-range'] = `bytes ${start}-${end}/${size}`;

	res.writeHead(ranged ? 206 : 200, headers);
	if (req.method === 'HEAD' || total === 0) {
		res.end();
		return;
	}

	const controller = new AbortController();
	const onClose = () => controller.abort();
	res.on('close', onClose);
	try {
		for (let offset = start; offset <= end; ) {
			const length = Math.min(chunkBytes, end - offset + 1);
			const chunk = await ctx.fs.readByteRange(target, { offset, length }, controller.signal);
			if (chunk.byteLength === 0) break;
			offset += chunk.byteLength;
			if (!(await writeChunk(res, chunk))) return;
		}
		res.end();
	} catch (error) {
		// A client that seeks away or closes mid-stream aborts the read on purpose.
		if (controller.signal.aborted || res.destroyed) return;
		// This handler owns the response, so a failed read ends it here rather
		// than escaping into the HTTP server as a rejected handler.
		if (res.headersSent) res.destroy();
		else sendStatus(res, 500, undefined, 'read failed');
	} finally {
		res.off('close', onClose);
	}
}

/**
 * Bundle activation: register the media route for this Web server's lifetime.
 * @param ctx - Host context; `inject` guarantees `webServer`, `fs`, and `connection`.
 * @param config - optional row config; `chunkBytes` overrides the streaming read size.
 */
export function apply(ctx, config) {
	const configured = config?.chunkBytes;
	const chunkBytes = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_CHUNK_BYTES;
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_PATH,
				handler: (req, res) => handle(ctx, chunkBytes, req, res)
			}),
		'dsh-video-preview: media route'
	);
}

/** Hard dependencies: without a Web server, a filesystem, or admission there is no safe route. */
export const inject = ['webServer', 'fs', 'connection'];
