/**
 * The route's error path: a backend read failure ends the response (a clean 500
 * before headers, a closed stream after them) instead of escaping into the HTTP
 * server as a rejected handler or leaving the request hanging.
 */
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoute } from './harness.js';

const dir = await mkdtemp(join(tmpdir(), 'dshvp-fail-'));
const file = join(dir, 'clip.mp4');
await writeFile(file, Buffer.alloc(4096, 3));

const results = [];
const route = await startRoute({ readFailure: true });
const failures = [];
process.on('unhandledRejection', (error) => failures.push(error));
try {
	const response = await fetch(route.url(file), { headers: { cookie: 'session=ok' } });
	const body = await response.text();
	results.push(
		response.status === 500
			? `pass a failed read answers 500 (${body.trim()})`
			: `FAIL a failed read answered ${response.status}`
	);
} catch (error) {
	// Headers were already sent, so the only honest signal is a closed stream.
	results.push(
		error.message === 'fetch failed'
			? 'pass a failed read after headers closes the stream'
			: `FAIL a failed read surfaced as: ${error.message}`
	);
} finally {
	await route.close();
	await rm(dir, { recursive: true, force: true });
}

// Let any leaked rejection surface before judging.
await new Promise((resolve) => setTimeout(resolve, 50));
results.push(
	failures.length === 0
		? 'pass no rejection escaped the handler'
		: `FAIL a rejection escaped the handler: ${failures[0]?.message}`
);

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
