"use client";

import { useEffect, useId, useRef } from "react";

/**
 * Cloudflare's Turnstile widget, rendered explicitly rather than by markup scan.
 *
 * **Explicit rendering (`render=explicit`) rather than letting the script find a `.cf-turnstile`
 * div.** The automatic mode scans the document once, when the script loads, which is the wrong
 * moment for a form that is mounted and unmounted by React — the sign-in form swaps its whole body
 * out for the two-factor step and back again, and a widget the script has already walked past never
 * comes back. Rendering by hand means this component owns the widget's whole life.
 *
 * The script is loaded here rather than through `next/script`, so that it is fetched only on an
 * install that has switched a challenge on. There is no `<Script>` in the tree of an install that
 * has not, and no request to Cloudflare from one.
 */

/**
 * The bits of Cloudflare's global this component uses.
 *
 * Declared structurally rather than pulled from a package: the widget's API surface here is three
 * functions, and a dependency for three function signatures is a dependency to keep upgraded.
 */
interface TurnstileApi {
	render: (
		container: HTMLElement,
		options: {
			sitekey: string;
			callback?: (token: string) => void;
			/** Called with Cloudflare's own error code when the widget cannot run. */
			"error-callback"?: (code: string) => void;
			"response-field"?: boolean;
			theme?: string;
		},
	) => string;
	reset: (widgetId: string) => void;
	remove: (widgetId: string) => void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
		/** Named in the script's own `onload` query parameter; see {@link SCRIPT_SRC}. */
		onTurnstileReady?: () => void;
	}
}

/** Cloudflare's loader. `onload` names the global the script calls once its API exists. */
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileReady";

/** Marks the one script tag this component shares across mounts. */
const SCRIPT_ID = "cf-turnstile-script";

/**
 * Loads Cloudflare's script once per document and resolves when its API is ready.
 *
 * Shared across mounts because the script defines a global: a second copy would re-run the loader
 * and race the first. The promise is cached at module scope for the same reason.
 */
let ready: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
	if (ready) {
		return ready;
	}

	ready = new Promise<void>((resolve, reject) => {
		if (window.turnstile) {
			resolve();
			return;
		}

		// `onload` fires only for a script this call is what inserted. A tag already in the document
		// from a previous mount may have fired its callback before this promise existed, so the
		// existing tag is waited on by its own load event instead.
		const existing = document.getElementById(SCRIPT_ID);
		if (existing) {
			existing.addEventListener("load", () => resolve());
			existing.addEventListener("error", () => reject(new Error("the Turnstile script could not be loaded")));
			return;
		}

		window.onTurnstileReady = () => resolve();

		const script = document.createElement("script");
		script.id = SCRIPT_ID;
		script.src = SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.addEventListener("error", () => reject(new Error("the Turnstile script could not be loaded")));
		document.head.append(script);
	});

	return ready;
}

/**
 * A Turnstile challenge inside a form.
 *
 * **`resetKey` is what makes a retry work, and it is not an optimisation.** A Turnstile token is
 * single-use and short-lived: Cloudflare refuses a second redemption of the same one with
 * `timeout-or-duplicate`. So a form that was refused for any reason — a wrong password as much as a
 * failed challenge — is holding a token that will never be accepted again, and submitting it a
 * second time fails for a reason the operator cannot see and cannot fix. Passing a value that
 * changes on every refused submission resets the widget and mints a fresh one.
 *
 * The widget writes its token into a hidden input named `cf-turnstile-response`, which is what the
 * server action reads. `response-field` is left at its default for exactly that reason.
 *
 * **`onUnavailable` is how a misconfigured challenge stops being a mystery.** A site key Cloudflare
 * refuses renders no widget and mints no token, so the form submits without one and is refused for a
 * reason that looks, to whoever is signing in, exactly like a challenge they failed. Cloudflare
 * reports the real cause to `error-callback` and nothing else ever sees it. It is passed up rather
 * than rendered here because this component is a widget in a form, and what the failure means for
 * that form is the form's own business.
 *
 * It carries no authority. Nothing the server does is conditioned on it, and it must stay that way:
 * a client that could claim the challenge was unavailable and be believed would be a client that
 * could switch the challenge off, which is the entire attack this feature exists to make expensive.
 *
 * @param siteKey the public key, from the install's settings
 * @param resetKey any value that changes when the form was refused and a fresh token is needed
 * @param onUnavailable called with Cloudflare's error code when the widget cannot run at all
 */
export function TurnstileWidget({
	siteKey,
	resetKey,
	onUnavailable,
}: {
	siteKey: string;
	resetKey: unknown;
	onUnavailable?: (code: string) => void;
}) {
	const container = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);
	// Rendering is asynchronous, so an unmount can land between the script resolving and the widget
	// being created. Without this the callback would render a widget into a detached node and leak it.
	const mounted = useRef(true);
	const id = useId();

	// Held in a ref, and deliberately not in the effect's dependencies. The widget is created once per
	// site key; listing a callback the parent re-declares on every render would tear the widget down
	// and build a new one each time, which is both a wasted Cloudflare round trip and a fresh token
	// replacing the one the operator has already solved.
	const report = useRef(onUnavailable);
	useEffect(() => {
		report.current = onUnavailable;
	}, [onUnavailable]);

	useEffect(() => {
		mounted.current = true;

		void loadTurnstile()
			.then(() => {
				if (!mounted.current || !container.current || !window.turnstile || widgetId.current !== null) {
					return;
				}
				widgetId.current = window.turnstile.render(container.current, {
					sitekey: siteKey,
					"error-callback": (code: string) => report.current?.(code),
				});
			})
			.catch(() => {
				// Swallowed on purpose. A challenge that cannot load must not stop somebody signing in:
				// the server treats an unreachable Cloudflare as no challenge for the same reason, and a
				// form that refused to submit here would be the lockout that reasoning exists to avoid.
				//
				// Reported through the same channel as a widget that loaded and then failed, because the
				// two are one situation from the form's point of view: no challenge will be solved here.
				// The script failing to load carries no code of its own, so it names itself.
				report.current?.("script-unavailable");
			});

		return () => {
			mounted.current = false;
			if (widgetId.current !== null && window.turnstile) {
				window.turnstile.remove(widgetId.current);
				widgetId.current = null;
			}
		};
	}, [siteKey]);

	useEffect(() => {
		if (widgetId.current !== null && window.turnstile) {
			window.turnstile.reset(widgetId.current);
		}
	}, [resetKey]);

	// `min-h` holds the widget's own height before it renders, so the button below it does not jump
	// down the moment Cloudflare's script arrives.
	return <div ref={container} id={id} className="flex min-h-[65px] justify-center" />;
}
