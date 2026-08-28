import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneLogArchives } from "@/lib/archive/prune";

describe("pruning log archives", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "fenpos-prune-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("removes a log archive whose period ended before the window", async () => {
		writeFileSync(join(directory, "logs-2020-01.db.gz"), "");
		writeFileSync(join(directory, `logs-${new Date().toISOString().slice(0, 7)}.db.gz`), "");

		const { removed } = await pruneLogArchives(directory, 365);

		expect(removed).toEqual(["logs-2020-01.db.gz"]);
		expect(existsSync(join(directory, "logs-2020-01.db.gz"))).toBe(false);
	});

	it("never removes an audit archive, however old", async () => {
		writeFileSync(join(directory, "audit-2020-01.db.gz"), "");

		const { removed } = await pruneLogArchives(directory, 365);

		// The epoch may only move on a person's decision. A prune that swept audit archives would
		// move it on a timer, which is the one thing it exists not to do.
		expect(removed).toEqual([]);
		expect(existsSync(join(directory, "audit-2020-01.db.gz"))).toBe(true);
	});

	it("leaves anything it does not recognise alone", async () => {
		writeFileSync(join(directory, "logs-2020-01.db.0f8c.partial"), "");
		writeFileSync(join(directory, "notes.txt"), "");

		await pruneLogArchives(directory, 365);

		expect(existsSync(join(directory, "logs-2020-01.db.0f8c.partial"))).toBe(true);
		expect(existsSync(join(directory, "notes.txt"))).toBe(true);
	});
});
