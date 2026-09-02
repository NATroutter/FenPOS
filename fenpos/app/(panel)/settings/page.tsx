import { type SettingFieldData, SettingsForm } from "@/app/(panel)/settings/settings-form";
import { permitsFor } from "@/lib/auth/permits";
import { requirePagePermission } from "@/lib/auth/require-permission";
import type { PanelPermission } from "@/lib/domain/panel-permissions";
import { CATEGORIES, listSettings, toClientDefinition } from "@/lib/settings/settings-service";

export const metadata = { title: "Settings" };

/** Never cached: the values are what the panel just wrote. */
export const dynamic = "force-dynamic";

/**
 * The Settings tab.
 *
 * What used to be the YAML file's global section. Everything
 * per-device lives on the Devices tab instead — a setting that applies to one printer belongs
 * next to that printer, not in a list of install-wide knobs where it would have to be qualified.
 */
export default async function SettingsPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("settings:read", "/settings");

	const settings = await listSettings();

	// Derived from `CATEGORIES` rather than written out, so a category added to the settings service
	// arrives here already asked about instead of silently defaulting to writable. The cast is the
	// one place this correspondence is asserted: `settings:write:<category>` is a real permission for
	// every member of `CATEGORIES`, and `panel-permissions.ts` is where that list lives.
	const writePermissions = CATEGORIES.map((category) => `settings:write:${category.id}` as PanelPermission);
	// Resolved here because a client component cannot read the database. Convenience only — every
	// write is refused again by its own gate; see `permitsFor`.
	const permits = await permitsFor(user, writePermissions);
	const writable = CATEGORIES.filter((category) => permits[`settings:write:${category.id}` as PanelPermission]).map(
		(category) => category.id,
	);

	// The definition is passed through whole, not flattened field by field — flattening a union
	// loses the discriminant the form narrows on. Which categories and controls actually appear is
	// the form's call, not this page's.
	//
	// `toClientDefinition` runs here, at the boundary, because this is the one place a definition
	// crosses from server to client. A string setting's `pattern` is a `RegExp`, which is not
	// serialisable across that boundary — passing it through would crash the page at render time
	// the moment a string setting exists, not at build time.
	const fields: SettingFieldData[] = settings.map((setting) => ({
		definition: toClientDefinition(setting.definition),
		value: setting.value,
		overridden: setting.overridden,
	}));

	// Filtered here rather than in the form: a category with nothing under it would otherwise
	// render as a nav entry leading to an empty panel, and `connections` and `panel` are exactly
	// that until settings are added to them. It also keeps `settings-service` — a server-only
	// module — out of the client form's import graph; only its types cross that boundary.
	const categories = CATEGORIES.filter((category) => fields.some((field) => field.definition.category === category.id));

	return (
		<div className="flex flex-col gap-5">
			<div>
				<SettingsForm categories={categories} settings={fields} writable={writable} />
			</div>
		</div>
	);
}
