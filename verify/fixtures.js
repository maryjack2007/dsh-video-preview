/**
 * Test fixtures: the media files the streaming checks need.
 *
 * The sample video is generated with ffmpeg rather than committed, so the
 * repository stays small and the bytes are reproducible from this file.
 */
import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The generated fixture's absolute path. Git-ignored; produced on demand. */
export const SAMPLE_VIDEO = fileURLToPath(new URL('../sample-video.mp4', import.meta.url));

async function present(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create the sample H.264/AAC video when it is absent.
 * `+faststart` puts the moov atom first, matching what a browser expects to
 * find at the head of a streamed mp4.
 * @returns the fixture's absolute path.
 * @throws a describing error when ffmpeg is unavailable or fails.
 */
export async function ensureSampleVideo() {
	if (await present(SAMPLE_VIDEO)) return SAMPLE_VIDEO;
	await mkdir(dirname(SAMPLE_VIDEO), { recursive: true });
	const args = [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'testsrc2=size=640x360:rate=25:duration=8',
		'-f',
		'lavfi',
		'-i',
		'sine=frequency=440:duration=8',
		'-c:v',
		'libx264',
		'-pix_fmt',
		'yuv420p',
		'-c:a',
		'aac',
		'-movflags',
		'+faststart',
		SAMPLE_VIDEO
	];
	try {
		await run('ffmpeg', args);
	} catch (error) {
		throw new Error(`ffmpeg is required to build the sample video: ${error.message}`);
	}
	return SAMPLE_VIDEO;
}
