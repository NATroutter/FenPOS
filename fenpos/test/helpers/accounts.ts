import { randomUUID } from "node:crypto";
import type { PanelUser } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
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
