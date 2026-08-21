import { type SettingFieldData, SettingsForm } from "@/app/(panel)/settings/settings-form";
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
	const settings = await listSettings();

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
	// render as a nav entry leading to an empty panel, and `media`, `security`, `connections` and
	// `panel` are exactly that until settings are added to them. It also keeps `settings-service`
	// — a server-only module — out of the client form's import graph; only its types cross that
	// boundary.
	const categories = CATEGORIES.filter((category) => fields.some((field) => field.definition.category === category.id));

	return (
		<div className="flex flex-col gap-5">
			<div>
				<SettingsForm categories={categories} settings={fields} />
			</div>
		</div>
	);
}
