/**
 * Contract checks for the media route: admission, path and suffix validation,
 * and the request/response shapes a browser's `<video>` element depends on.
 *
 * Runs the real route on a real HTTP server against the real filesystem.
 */
import { open, stat, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoute } from './harness.js';

const SIZE = 5 * 1024 * 1024 + 12345;
const COOKIE = 'session=ok';

const dir = await mkdtemp(join(tmpdir(), 'dshvp-route-'));
const video = join(dir, 'clip.mp4');
const text = join(dir, 'notes.txt');
await writeFile(video, Buffer.alloc(SIZE, 7));
await writeFile(text, 'hello');

const route = await startRoute();
const results = [];

/**
 * Run one request and judge its response.
 * @param name - the check's label.
 * @param url - request URL.
 * @param init - fetch options.
 * @param assert - receives the response and its body; may return a detail string.
 */
async function check(name, url, init, assert) {
	try {
		const response = await fetch(url, init);
		const body = new Uint8Array(await response.arrayBuffer());
		const detail = await assert(response, body);
		results.push(`pass ${name}${detail === undefined ? '' : ` (${detail})`}`);
	} catch (error) {
		results.push(`FAIL ${name}: ${error.message}`);
	}
}

const authed = { cookie: COOKIE };
const q = (path) => route.url(path);

try {
	await check('401 without the browser cookie', q(video), {}, (res) => {
		if (res.status !== 401) throw new Error(`status ${res.status}`);
	});
	await check('405 for POST', q(video), { method: 'POST', headers: authed }, (res) => {
		if (res.status !== 405) throw new Error(`status ${res.status}`);
	});
	await check('400 for a missing path', route.base, { headers: authed }, (res) => {
		if (res.status !== 400) throw new Error(`status ${res.status}`);
	});
	await check('400 for a relative path', q('clip.mp4'), { headers: authed }, (res) => {
		if (res.status !== 400) throw new Error(`status ${res.status}`);
	});
	await check('415 for an unclaimed suffix', q(text), { headers: authed }, (res) => {
		if (res.status !== 415) throw new Error(`status ${res.status}`);
	});
	await check('404 for an absent file', q(join(dir, 'nope.mp4')), { headers: authed }, (res) => {
		if (res.status !== 404) throw new Error(`status ${res.status}`);
	});
	await check('200 with the complete file', q(video), { headers: authed }, (res, bytes) => {
		if (res.status !== 200) throw new Error(`status ${res.status}`);
		if (res.headers.get('content-type') !== 'video/mp4') throw new Error(`type ${res.headers.get('content-type')}`);
		if (res.headers.get('accept-ranges') !== 'bytes') throw new Error('no accept-ranges');
		if (bytes.byteLength !== SIZE) throw new Error(`length ${bytes.byteLength}`);
		return `${bytes.byteLength} bytes`;
	});
	await check('206 for bytes=0-1023', q(video), { headers: { ...authed, range: 'bytes=0-1023' } }, (res, bytes) => {
		if (res.status !== 206) throw new Error(`status ${res.status}`);
		if (res.headers.get('content-range') !== `bytes 0-1023/${SIZE}`) throw new Error(`content-range ${res.headers.get('content-range')}`);
		if (bytes.byteLength !== 1024) throw new Error(`length ${bytes.byteLength}`);
		return res.headers.get('content-range');
	});
	await check('206 for an open-ended range', q(video), { headers: { ...authed, range: `bytes=${SIZE - 10}-` } }, (res, bytes) => {
		if (res.status !== 206) throw new Error(`status ${res.status}`);
		if (bytes.byteLength !== 10) throw new Error(`length ${bytes.byteLength}`);
		if (bytes[0] !== 7) throw new Error('wrong bytes');
		return `${bytes.byteLength} bytes`;
	});
	await check('206 for a suffix range', q(video), { headers: { ...authed, range: 'bytes=-256' } }, (res, bytes) => {
		if (res.status !== 206) throw new Error(`status ${res.status}`);
		if (res.headers.get('content-range') !== `bytes ${SIZE - 256}-${SIZE - 1}/${SIZE}`) throw new Error(`content-range ${res.headers.get('content-range')}`);
		if (bytes.byteLength !== 256) throw new Error(`length ${bytes.byteLength}`);
	});
	await check('206 clamps an end past EOF', q(video), { headers: { ...authed, range: `bytes=${SIZE - 5}-99999999` } }, (res, bytes) => {
		if (res.status !== 206) throw new Error(`status ${res.status}`);
		if (bytes.byteLength !== 5) throw new Error(`length ${bytes.byteLength}`);
	});
	await check('206 crosses the internal chunk boundary', q(video), { headers: { ...authed, range: `bytes=${1024 * 1024 - 100}-${2 * 1024 * 1024 + 100}` } }, (res, bytes) => {
		const expected = 2 * 1024 * 1024 + 100 - (1024 * 1024 - 100) + 1;
		if (res.status !== 206) throw new Error(`status ${res.status}`);
		if (bytes.byteLength !== expected) throw new Error(`length ${bytes.byteLength} expected ${expected}`);
		return `${bytes.byteLength} bytes`;
	});
	await check('416 for a range that starts past EOF', q(video), { headers: { ...authed, range: `bytes=${SIZE}-` } }, (res) => {
		if (res.status !== 416) throw new Error(`status ${res.status}`);
		if (res.headers.get('content-range') !== `bytes */${SIZE}`) throw new Error(`content-range ${res.headers.get('content-range')}`);
	});
	await check('200 for an unparsable range header', q(video), { headers: { ...authed, range: 'bytes=abc-def' } }, (res, bytes) => {
		if (res.status !== 200) throw new Error(`status ${res.status}`);
		if (bytes.byteLength !== SIZE) throw new Error(`length ${bytes.byteLength}`);
	});
	await check('HEAD sends headers without a body', q(video), { method: 'HEAD', headers: authed }, (res, bytes) => {
		if (res.status !== 200) throw new Error(`status ${res.status}`);
		if (res.headers.get('content-length') !== String(SIZE)) throw new Error(`content-length ${res.headers.get('content-length')}`);
		if (bytes.byteLength !== 0) throw new Error(`body ${bytes.byteLength}`);
	});

	// A client that hangs up mid-stream must not leave the route writing: the
	// read is aborted and the route keeps serving.
	try {
		const aborted = await fetch(q(video), { headers: authed });
		const reader = aborted.body.getReader();
		const first = await reader.read();
		if (first.value.byteLength === 0) throw new Error('no first chunk');
		await reader.cancel();
		results.push(`pass a client abort leaves the route healthy (first chunk ${first.value.byteLength} bytes)`);
	} catch (error) {
		results.push(`FAIL a client abort leaves the route healthy: ${error.message}`);
	}
	const after = await fetch(q(video), { headers: { ...authed, range: 'bytes=0-15' } });
	results.push(
		after.status === 206
			? 'pass the route still serves after an abort'
			: `FAIL the route stopped serving after an abort: status ${after.status}`
	);
} finally {
	await route.close();
	await rm(dir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
