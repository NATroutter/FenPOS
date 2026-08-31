import { randomUUID } from "node:crypto";
import type { PanelUser } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
import type { PanelPermission } from "@/lib/domain/panel-permissions";
import { panelUser } from "@/test/helpers/panel-user";

/**
 * Creates a real `user` row and hands back a {@link PanelUser} naming it.
 *
 * Both halves are load-bearing, for two different callers. Something that writes to a table with a
 * foreign key on `userId` — `prisma.avatar.create` among them — needs an id SQLite will actually
 * accept, not a string a test made up; a mocked session resolver, which a later task hands this
 * same return value to, needs the complete `PanelUser` shape (`sessionId` included) rather than a
 * bare `{ id, name, email }` — see `panelUser`'s own doc for what silently goes wrong when a fixture
 * is missing a field the type promises. One call producing both means nothing has to remember which
 * of the two a given test needs, or discover the gap the way a hand-rolled fixture once did by
 * leaving one out with nothing to notice.
 *
 * `id` and `email` are derived from a fresh `randomUUID()` each call, so a file that calls this more
 * than once gets independent accounts rather than a collision on `user`'s `email` unique constraint.
 *
 * @returns a `PanelUser` naming a real, freshly created `user` row
 */
export async function makeUser(): Promise<PanelUser> {
	const id = randomUUID();
	const name = "Test User";
	const email = `${id}@example.com`;

	await prisma.user.create({ data: { id, name, email, isSuperuser: false } });

	return panelUser({ id, name, email, isSuperuser: false });
}

/**
 * Creates a real, **non-superuser** account holding exactly the given grants, and hands back a
 * {@link PanelUser} naming it.
 *
 * The non-superuser part is load-bearing, not incidental. `panel-action.ts`'s `gate()` lets a
 * superuser through without ever calling {@link userHolds} — see its own doc — and `panelUser`'s
 * default is `isSuperuser: true`. A fixture that returned a superuser here would make a test written
 * against a granted permission pass for the wrong reason: it would prove the superuser bypass works,
 * not that the grant does. Explicitly `isSuperuser: false`, so `userHolds` has no shortcut and the
 * rows below are what decide the answer.
 *
 * The rows are real `userPermission` grants — the same table {@link userHolds} reads through
 * `effectivePermissions` — rather than anything that only *looks* like a grant, for the same reason
 * `permission-matrix.test.ts` seeds its own accounts this way: a permission checked against a row
 * the resolver never reads would pass a test that a stale or misspelled column name would not catch.
 *
 * @param permissions the complete set of permissions to grant, individually (no roles)
 * @returns a `PanelUser` naming a real, freshly created, non-superuser `user` row
 */
export async function makeUserWith(permissions: readonly PanelPermission[]): Promise<PanelUser> {
	const id = randomUUID();
	const name = "Test User";
	const email = `${id}@example.com`;

	await prisma.user.create({ data: { id, name, email, isSuperuser: false } });
	if (permissions.length > 0) {
		await prisma.userPermission.createMany({ data: permissions.map((permission) => ({ userId: id, permission })) });
	}

	return panelUser({ id, name, email, isSuperuser: false });
}
