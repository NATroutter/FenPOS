/**
 * Whether a promise has already settled — resolved or rejected — without waiting for it.
 *
 * A timeout test needs to assert a promise has *not yet* settled at some point before its
 * deadline. Racing that assertion against a real delay would make the check itself take as long
 * as the thing it is verifying, which is exactly what fake timers exist to avoid. Attaching a
 * handler and yielding a few turns of the microtask queue is enough: if the promise settled before
 * this was called, the attached handler is already scheduled and runs during the loop below; if it
 * has not, nothing runs and this returns false.
 *
 * @param promise the promise to inspect
 * @returns whether it has already resolved or rejected
 */
export async function settled(promise: Promise<unknown>): Promise<boolean> {
	let isSettled = false;
	promise.then(
		() => {
			isSettled = true;
		},
		() => {
			isSettled = true;
		},
	);

	// Several turns rather than one: an async function chains one microtask per `await` it
	// contains before its own promise settles, so a single turn can miss a promise that settled
	// through more than one layer of `await`.
	for (let turn = 0; turn < 10; turn += 1) {
		await Promise.resolve();
	}

	return isSettled;
}
