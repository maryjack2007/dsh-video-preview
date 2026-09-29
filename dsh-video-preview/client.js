/**
 * Browser half of the video preview bundle.
 *
 * Two registrations reach the shipped document preview through its public
 * extension points only:
 *
 * 1. a `DocumentPreviewDefinition` claiming the video suffixes, so a video file
 *    selects this implementation instead of the "cannot preview" empty state;
 * 2. its keyed body in `sidebar.right.tab.document`, rendered where the owner
 *    dispatches the implementation id.
 *
 * The body renders the browser's own `<video>` element and points it at the
 * Host route the bundle's other half registers, so the browser streams and seeks
 * the file itself; no page-side read holds the video in memory. The definition
 * loads in `renderer` mode because this body owns that transport, and it reports
 * `loaded`/`failed` so the tab's reload control and change tracking stay correct.
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-video-preview',
	factory(require) {
		const React = require('react');

		/**
		 * Implementation id: the preview definition's name and the keyed body's
		 * cell key. The owner dispatches this exact value, so the two must match.
		 */
		const PREVIEW_ID = '@local/dsh-video-preview/video';

		/** Locale namespace holding this renderer's labels. */
		const LOCALE_NS = 'dshVideoPreview';

		/**
		 * Host route, resolved against the document's own base so a deployment
		 * mounted under a path prefix reaches the same route through its proxy.
		 */
		const ROUTE = 'dsh-media/video';

		/** Suffixes this renderer offers; every one is binary, so none falls back to text. */
		const EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg'];

		/** Offered suffix to browser media type; mirrors the Host route's own table. */
		const MEDIA_TYPES = {
			mp4: 'video/mp4',
			m4v: 'video/mp4',
			webm: 'video/webm',
			mov: 'video/quicktime',
			ogv: 'video/ogg',
			ogg: 'video/ogg'
		};

		const en = {
			title: 'Video',
			loading: 'Loading video…',
			failed: 'This video cannot be played.',
			retry: 'Retry',
			unavailable: 'The file could not be read.'
		};

		const zh = {
			title: '视频',
			loading: '正在载入视频…',
			failed: '无法播放此视频。',
			retry: '重试',
			unavailable: '无法读取该文件。'
		};

		/**
		 * Renderer styles, written against host theme tokens only so both themes
		 * are covered without a per-theme override.
		 */
		const CSS = `
.dshvp-stage {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 8px;
	box-sizing: border-box;
	width: 100%;
	height: 100%;
	min-height: 0;
	padding: 12px;
	overflow: auto;
}
.dshvp-video {
	max-width: 100%;
	max-height: 100%;
	border-radius: 8px;
	background: var(--dsw-alias-bg-layer-2);
	outline: 1px solid var(--dsw-alias-border-l1);
}
.dshvp-status {
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary);
}
.dshvp-error {
	display: flex;
	align-items: center;
	gap: 8px;
	color: var(--dsw-alias-state-error-primary);
}
.dshvp-retry {
	font: inherit;
	font-size: 12px;
	padding: 2px 10px;
	border-radius: 6px;
	cursor: pointer;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l1);
}
.dshvp-retry:hover {
	border-color: var(--dsw-alias-border-l2);
}
`;

		/**
		 * The media type for a path's final suffix.
		 * @param path - file path or filename.
		 * @returns the media type, or undefined for a suffix this renderer does not claim.
		 */
		function mediaTypeOf(path) {
			const normalized = path.replaceAll('\\', '/');
			const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
			const dot = name.lastIndexOf('.');
			if (dot < 0) return undefined;
			return MEDIA_TYPES[name.slice(dot + 1)];
		}

		/**
		 * Build the streaming URL for one revision of one file.
		 * @param path - absolute path of the file in its execution environment.
		 * @param version - the resource version, so a changed file gets a new URL.
		 * @param revision - the content revision, so a manual reload re-fetches.
		 * @returns the absolute same-origin URL the video element requests.
		 */
		function previewUrl(path, version, revision) {
			const url = new URL(ROUTE, document.baseURI);
			url.searchParams.set('path', path);
			if (version !== undefined) url.searchParams.set('v', String(version));
			url.searchParams.set('r', String(revision));
			return url.href;
		}

		/**
		 * Insert this renderer's stylesheet once per client run.
		 * @param css - the stylesheet body.
		 * @returns the disposer removing the tag.
		 */
		function insertStyles(css) {
			const tag = document.createElement('style');
			tag.dataset.dshVideoPreview = '';
			tag.textContent = css;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/**
		 * One line of secondary text, for a state with no video yet.
		 * @param message - localized text.
		 * @param role - ARIA role for the line.
		 * @returns the paragraph element.
		 */
		function statusLine(message, role) {
			return React.createElement('p', { className: 'dshvp-status', role }, message);
		}

		/**
		 * The mounted video: the element owns loading, buffering, and seeking, so
		 * this component only mirrors its state into the tab's bookkeeping.
		 * @param props - URL, the owner's loading request, source version, labels, scrollport.
		 * @returns the stage holding the video and its own status.
		 */
		function VideoStage(props) {
			const { src, request, version, t, scrollportRef } = props;
			const [phase, setPhase] = React.useState('loading');
			const handleLoaded = React.useCallback(() => {
				setPhase('ready');
				request.loaded(version);
			}, [request, version]);
			const handleError = React.useCallback(() => {
				setPhase('failed');
				request.failed();
			}, [request]);
			return React.createElement(
				'div',
				{ className: 'dshvp-stage', ref: scrollportRef },
				React.createElement('video', {
					className: 'dshvp-video',
					src,
					controls: true,
					playsInline: true,
					preload: 'metadata',
					onLoadedMetadata: handleLoaded,
					onError: handleError
				}),
				phase === 'loading' ? statusLine(t('loading'), 'status') : null,
				phase === 'failed'
					? React.createElement(
							'div',
							{ className: 'dshvp-status dshvp-error', role: 'alert' },
							React.createElement('span', null, t('failed')),
							React.createElement('button', { type: 'button', className: 'dshvp-retry', onClick: () => request.reload() }, t('retry'))
						)
					: null
			);
		}

		/**
		 * The keyed document body: resolve the file's absolute path from the standard
		 * resource hook, then hand the video element a URL to stream.
		 * @param props - document owner props plus this renderer's bound labels.
		 * @returns the stage, a status line, or null while the owner selects a renderer.
		 */
		function VideoBody(props) {
			// Hooks stay unconditional: every return below follows this one call.
			const meta = props.useResource(props.resourceAddress);
			const content = props.content;
			const request = content !== undefined && content.kind === 'renderer' ? content : undefined;
			if (request === undefined) return null;
			const t = props.t;
			if (meta.status === 'failed') return statusLine(t('unavailable'), 'alert');
			const value = meta.value;
			if (value === undefined) return statusLine(t('loading'), 'status');
			const path = value.absolutePath;
			if (path === undefined || mediaTypeOf(path) === undefined) return statusLine(t('failed'), 'alert');
			const src = previewUrl(path, value.version, request.revision);
			// Keyed by URL: a new file version or a reload remounts the element,
			// so it never keeps the previous source's buffers or error state.
			return React.createElement(VideoStage, {
				key: src,
				src,
				request,
				version: value.version,
				t,
				scrollportRef: props.scrollportRef
			});
		}

		return {
			inject: ['documentPreviews', 'slots', 'locale'],
			/**
			 * Client plugin body: register the labels, the definition, and the body.
			 * @param ctx - client root context.
			 */
			apply(ctx) {
				const t = ctx.locale.bind(LOCALE_NS);
				ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-video-preview: dictionaries');
				ctx.effect(() => insertStyles(CSS), 'dsh-video-preview: stylesheet');
				ctx.effect(
					() =>
						ctx.documentPreviews.register({
							id: PREVIEW_ID,
							extensions: EXTENSIONS,
							binaryExtensions: EXTENSIONS,
							priority: 'extension',
							title: () => t('title'),
							loading: 'renderer',
							wrap: false
						}),
					'dsh-video-preview: definition'
				);
				const Body = (props) => React.createElement(VideoBody, { ...props, t: props.t ?? t });
				ctx.effect(
					() =>
						ctx.slots.inject('sidebar.right.tab.document', () =>
							ctx.slots.register({ name: 'sidebar.right.tab.document', key: PREVIEW_ID }, Body)
						),
					'dsh-video-preview: body'
				);
			}
		};
	}
});
