import { type SettingFieldData, SettingsForm } from "@/app/(panel)/settings/settings-form";
import { listSettings } from "@/lib/settings/settings-service";

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

	const fields: SettingFieldData[] = settings.map((setting) => ({
		key: setting.definition.key,
		label: setting.definition.label,
		description: setting.definition.description,
		min: setting.definition.min,
		max: setting.definition.max,
		fallback: setting.definition.fallback,
		unit: setting.definition.unit,
		value: setting.value,
		overridden: setting.overridden,
	}));

	return (
		<div className="flex flex-col gap-5">
			<div>
				<SettingsForm settings={fields} />
			</div>
		</div>
	);
}
