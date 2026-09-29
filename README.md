# dsh-video-preview

**English** | [中文](./README.zh.md)

Streaming video preview for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar file preview. Open an `mp4`, `webm`, `mov`, or Ogg video in the file panel and play it — with seeking — instead of seeing "this file cannot be previewed".

## Why streaming instead of reading the bytes

The document preview offers three ways for a renderer to get its content. The obvious one, `bytes-complete`, hands the renderer the whole file. For video that is the wrong tool:

- **It is capped.** `workspaceFiles` refuses a complete-file read above `maxFileBytes` (32 MiB by default) and refuses it *without truncating*, so any real video is unviewable.
- **Nothing plays until the end arrives.** The first frame would wait on the whole download.
- **Seeking would re-read.** The player would need the entire file in memory to jump to a timestamp.

So this plugin uses `renderer` mode instead: the document body owns its own transport and points the browser's `<video>` element at an HTTP route that supports `Range`. The browser then does what it is already good at — it fetches a bit, starts playing, and range-requests only the windows a seek needs. Memory stays flat regardless of file size.

## Supported formats

| Suffix | Media type | Notes |
|---|---|---|
| `.mp4` | `video/mp4` | H.264/AAC is the safest combination |
| `.m4v` | `video/mp4` | |
| `.webm` | `video/webm` | VP8/VP9/AV1 + Opus/Vorbis |
| `.mov` | `video/quicktime` | plays when it carries a codec the browser supports |
| `.ogv` | `video/ogg` | |
| `.ogg` | `video/ogg` | |

A container the browser cannot decode is deliberately **not** claimed: `mkv`, `avi`, `wmv`, and `flv` keep their existing "cannot preview" state. Claiming them would only replace an honest message with a player that always errors.

## Install

Install the `dsh-video-preview/` directory as a bundle in your DSH profile — with a DSH agent, that is the `plugin_manager` tool's `install_bundle` action pointed at this directory. The bundle patch inserts one plugin row, so the change is live without a restart and survives the next one. It applies per profile.

The bundle has **zero runtime dependencies** and no build step, so installation touches no npm registry.

## How it works

Two halves, connected by one route.

**Host** (`index.js`) registers an exact route at `/dsh-media/video`:

```
GET /dsh-media/video?path=<absolute path>
Range: bytes=<start>-<end>
```

It answers `200` (whole file), `206` (requested window, with `Content-Range`), `416` (unsatisfiable range), and `HEAD`. Bytes are read through the composed filesystem (`ctx.fs`) — the same read authority `workspaceFiles` uses — in windows of `chunkBytes`, written with backpressure, and the read is aborted when the client seeks away or disconnects.

**Client** (`client.js`) makes two registrations through the document preview's public extension points:

1. a `DocumentPreviewDefinition` claiming the suffixes above, so a video selects this implementation;
2. its keyed body in the `sidebar.right.tab.document` slot.

The body resolves the file's absolute path from the standard `useResource` hook and hands the `<video>` element the streaming URL, keyed by URL so a new file version or a manual reload remounts cleanly. It reports `loaded`/`failed` back to the owner, which keeps the toolbar's reload control and the change tracking correct.

## Security

The route is **not** an unauthenticated file server. Every request is admitted by the browser-connection carrier (`ctx.connection.requestRejection`) before any path is resolved: the request must reach a loopback or configured trusted authority, carry the signed browser-session cookie, and not be cross-site. A refused request never touches the filesystem. On top of that the route requires an absolute path and a suffix from the table above; anything else is `400`/`415` before a read is attempted.

## Configuration

Set on the plugin row in `cordis.patch.yml`:

```yaml
- id: dsh-video-preview
  name: '@local/dsh-video-preview'
  config:
    chunkBytes: 4194304   # bytes per streaming read; default 1048576 (1 MiB)
```

`chunkBytes` bounds only the memory held per read, never the file size that can be streamed.

## Tests

No test framework; plain scripts against a real HTTP server, a real filesystem, and real media bytes. Requires `ffmpeg` and `ffprobe` — the sample video is generated on demand rather than committed.

```bash
node verify/route.test.js     # 17 checks: admission, validation, HTTP/Range contract, abort recovery
node verify/stream.test.js    #  6 checks: byte-exactness and decodability
node verify/failure.test.js   #  2 checks: the error path ends the response cleanly
```

`stream.test.js` is the interesting one: it reassembles one byte-for-byte copy of the source from 64 KiB range responses, then runs `ffprobe` over the reassembled stream to confirm it still reports the source's own codecs, dimensions, and duration — evidence that a browser seeking around the stream receives a valid video, not just plausible-looking bytes.

## Layout

```
dsh-video-preview/   the installable bundle
  package.json       manifest: dsh.bundle.patch + dsh.client
  cordis.patch.yml   inserts the plugin row
  index.js           Host half — the streaming media route
  client.js          Client half — preview definition and video body
  locale/            plugin-manager display metadata (en, zh)
verify/              the test suites and their shared harness
```

## Limitations

- Videos the browser cannot decode stay unpreviewable by design (see above).
- A `Range` request can only be honoured when the filesystem backend reports a size; without one the route serves a plain `200` stream that plays but cannot be seeked.
- Same-origin only, by construction: the route is reached relative to the document, and the connection carrier rejects cross-site requests.

## License

[MIT](./LICENSE)
