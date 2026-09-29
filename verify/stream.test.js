/**
 * Proves the served bytes are the file's bytes, and that what a browser
 * receives is a decodable video: sequential windows reassemble byte-for-byte,
 * and the reassembled stream passes ffprobe with the source's own properties.
 *
 * Requires ffmpeg (fixture generation) and ffprobe (verification).
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureSampleVideo } from './fixtures.js';
import { startRoute } from './harness.js';

const run = promisify(execFile);
const COOKIE = { cookie: 'session=ok' };

/** ffprobe one file and return its stream and format facts, canonically ordered. */
async function probe(path) {
	const { stdout } = await run('ffprobe', [
		'-hide_banner',
		'-v',
		'error',
		'-show_entries',
		'format=duration,size',
		'-show_entries',
		'stream=codec_name,width,height',
		'-of',
		'default=noprint_wrappers=1',
		path
	]);
	return stdout.trim().split('\n').sort().join(' ');
}

const source = await ensureSampleVideo();
const dir = await mkdtemp(join(tmpdir(), 'dshvp-stream-'));
const route = await startRoute();
const results = [];

try {
	const original = await readFile(source);
	const size = original.byteLength;
	const sourceFacts = await probe(source);

	// A browser's first request: the header, then whatever it decides to buffer.
	const full = await fetch(route.url(source), { headers: COOKIE });
	if (full.status !== 200) throw new Error(`full status ${full.status}`);
	const served = Buffer.from(await full.arrayBuffer());
	const fullPath = join(dir, 'full.mp4');
	await writeFile(fullPath, served);
	const servedFacts = await probe(fullPath);
	results.push(
		servedFacts === sourceFacts
			? `pass the served file is decodable and identical in shape (${servedFacts})`
			: `FAIL the served file differs: source [${sourceFacts}] served [${servedFacts}]`
	);

	// A seek: ranges must reassemble without a gap or an overlap.
	const WINDOW = 64 * 1024;
	const parts = [];
	for (let offset = 0; offset < size; offset += WINDOW) {
		const end = Math.min(offset + WINDOW - 1, size - 1);
		const response = await fetch(route.url(source), { headers: { ...COOKIE, range: `bytes=${offset}-${end}` } });
		if (response.status !== 206) throw new Error(`window ${offset} status ${response.status}`);
		parts.push(Buffer.from(await response.arrayBuffer()));
	}
	const reassembled = Buffer.concat(parts);
	results.push(
		reassembled.equals(original)
			? `pass ${parts.length} sequential windows reassemble byte-for-byte (${size} bytes)`
			: `FAIL reassembled windows differ from the source (${reassembled.length} vs ${size})`
	);
	const reassembledPath = join(dir, 'reassembled.mp4');
	await writeFile(reassembledPath, reassembled);
	results.push(
		(await probe(reassembledPath)) === sourceFacts
			? 'pass the reassembled stream is decodable'
			: 'FAIL the reassembled stream is not decodable'
	);

	// A backwards seek must not depend on anything read before it.
	const tail = await fetch(route.url(source), { headers: { ...COOKIE, range: `bytes=${size - 4096}-` } });
	const tailBytes = Buffer.from(await tail.arrayBuffer());
	results.push(
		tailBytes.equals(original.subarray(size - 4096))
			? 'pass a tail seek matches the source tail'
			: 'FAIL a tail seek returned other bytes'
	);
	const head = await fetch(route.url(source), { headers: { ...COOKIE, range: 'bytes=0-4095' } });
	const headBytes = Buffer.from(await head.arrayBuffer());
	results.push(
		headBytes.equals(original.subarray(0, 4096))
			? 'pass a head range matches the source head'
			: 'FAIL a head range returned other bytes'
	);

	// A second file must serve its own bytes, so nothing is cached by mistake.
	const second = join(dir, 'second.mp4');
	await run('ffmpeg', [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1',
		'-c:v', 'libx264', '-pix_fmt', 'yuv420p',
		'-movflags', '+faststart',
		second
	]);
	const secondBytes = await readFile(second);
	const secondTail = await fetch(route.url(second), { headers: { ...COOKIE, range: `bytes=${secondBytes.byteLength - 512}-` } });
	const secondTailBytes = Buffer.from(await secondTail.arrayBuffer());
	results.push(
		secondTail.status === 206 && secondTailBytes.equals(secondBytes.subarray(secondBytes.byteLength - 512))
			? 'pass a second file serves its own tail'
			: `FAIL a second file tail: status ${secondTail.status}`
	);
} finally {
	await route.close();
	await rm(dir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
