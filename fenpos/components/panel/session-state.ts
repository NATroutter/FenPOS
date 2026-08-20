"use client";

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

/**
 * A string state that survives leaving the page.
 *
 * The app router unmounts a page's components when you navigate away, so anything held in
 * `useState` is gone by the time you come back. On most tabs that is correct — a filter or a
 * dialog should not haunt you. On the Tools tab it is destructive: an operator composing a
 * receipt who opens Docs to check a tag returns to an empty editor and has to start again.
 *
 * Session storage rather than local storage, because the right lifetime is the sitting: what
 * you were drafting an hour ago in another window is not what you want back tomorrow.
 *
 * **The stored value is read after mount, never during render.** Reading it while rendering
 * would make the server's HTML and the browser's first paint disagree, which React reports as
 * a hydration error. The cost is one frame showing the initial value.
 *
 * @param key storage key, namespaced by the tool that owns it
 * @param initial the value before anything has been stored, and on a fresh session
 * @returns the current value and a setter, as `useState` does
 */
export function useSessionState(key: string, initial: string): [string, Dispatch<SetStateAction<string>>] {
	const [value, setValue] = useState(initial);
	const [restored, setRestored] = useState(false);

	useEffect(() => {
		try {
			const stored = window.sessionStorage.getItem(key);
			if (stored !== null) {
				setValue(stored);
			}
		} catch {
			// Session storage is unavailable in some privacy modes. The tool still works; it
			// simply forgets, which is the behaviour it had before this hook existed.
		}
		setRestored(true);
	}, [key]);

	useEffect(() => {
		// Not before the restore has run, or the initial value would overwrite what was stored.
		if (!restored) {
			return;
		}
		try {
			window.sessionStorage.setItem(key, value);
		} catch {
			// Quota or privacy mode; nothing to do but keep working.
		}
	}, [key, value, restored]);

	return [value, setValue];
}
