"use client";

import { RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { changePassword, resetSetting, saveSetting } from "@/app/(panel)/settings/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/** One setting as the form holds it. */
export interface SettingFieldData {
	key: string;
	label: string;
	description: string;
	min: number;
	max: number;
	fallback: number;
	unit: string;
	value: number;
	overridden: boolean;
}

/**
 * The global settings form.
 *
 * Each field saves on its own rather than through one submit button. These are unrelated knobs,
 * and a single save would make changing one of them look like a commitment to whatever state the
 * other six happened to be in on screen.
 */
export function SettingsForm({ settings }: { settings: SettingFieldData[] }) {
	return (
		<Card>
			<CardHeader className="border-b border-border pb-3">
				<h3 className="text-[13px] font-medium">Limits and retention</h3>
				<p className="mt-1 text-[12px] text-muted-foreground">
					Applied to every device that does not override them. A field showing "default" has nothing stored, so it
					follows the built-in value through upgrades.
				</p>
			</CardHeader>
			<CardContent className="flex flex-col gap-4 pt-4">
				{settings.map((setting) => (
					<SettingField key={setting.key} setting={setting} />
				))}
			</CardContent>
		</Card>
	);
}

/** One setting, saved on blur or on Enter. */
function SettingField({ setting }: { setting: SettingFieldData }) {
	const [value, setValue] = useState(String(setting.value));
	const [pending, startTransition] = useTransition();

	const commit = (): void => {
		const parsed = Number.parseInt(value, 10);
		if (!Number.isInteger(parsed) || parsed === setting.value) {
			setValue(String(setting.value));
			return;
		}
		startTransition(async () => {
			const result = await saveSetting(setting.key, parsed);
			if (result.error) {
				toast.error(result.error);
				setValue(String(setting.value));
			} else {
				toast.success(`${setting.label} saved.`);
			}
		});
	};

	return (
		<Field>
			<div className="flex items-center gap-2">
				<FieldLabel htmlFor={setting.key} className="flex-1">
					{setting.label}
				</FieldLabel>
				<span className="font-mono text-[11px] text-subtle-foreground">{setting.key}</span>
			</div>

			<div className="flex items-center gap-2">
				<Input
					id={setting.key}
					type="number"
					className="w-[160px] font-mono"
					value={value}
					disabled={pending}
					min={setting.min}
					max={setting.max}
					onChange={(event) => setValue(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.currentTarget.blur();
						}
					}}
				/>
				<span className="text-[11.5px] text-subtle-foreground">{setting.unit}</span>

				{setting.overridden ? (
					<Button
						variant="ghost"
						size="icon"
						className="size-8"
						title={`Reset to ${setting.fallback}`}
						aria-label="Reset to the default"
						disabled={pending}
						onClick={() =>
							startTransition(async () => {
								const result = await resetSetting(setting.key);
								if (result.error) {
									toast.error(result.error);
								} else {
									setValue(String(setting.fallback));
									toast.success(`${setting.label} reset to its default.`);
								}
							})
						}
					>
						{pending ? <Spinner className="size-3.5" /> : <RotateCcw className="size-3.5" />}
					</Button>
				) : (
					<span className="text-[11.5px] text-subtle-foreground">default</span>
				)}
			</div>

			<FieldDescription>
				{setting.description} Between {setting.min} and {setting.max}.
			</FieldDescription>
		</Field>
	);
}

/**
 * Changing the administrator password.
 *
 * The current password is asked for even though the caller is signed in. A session left open on
 * an unattended machine in a back office is exactly the case this defends against, and it costs
 * one field to close.
 */
export function PasswordForm({ isGenerated }: { isGenerated: boolean }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const submit = (): void => {
		setError(null);
		if (next !== confirm) {
			setError("The new passwords do not match.");
			return;
		}
		startTransition(async () => {
			const result = await changePassword(current, next);
			if (result.error) {
				setError(result.error);
				return;
			}
			setCurrent("");
			setNext("");
			setConfirm("");
			toast.success("Password changed. Other sessions have been signed out.");
		});
	};

	return (
		<Card>
			<CardHeader className="border-b border-border pb-3">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="text-[13px] font-medium">Administrator password</h3>
					{/* States the credential's provenance, not merely that a password exists. "Set by
					    you" is the fact an operator is checking for; a green tick alone would read as
					    approval of a password this page cannot judge. */}
					{isGenerated ? (
						<Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
							<TriangleAlert className="size-3" />
							Generated at first boot
						</Badge>
					) : (
						<Badge variant="outline" className="border-emerald-900 bg-emerald-950 text-emerald-400">
							<ShieldCheck className="size-3" />
							Set by you
						</Badge>
					)}
				</div>
				<p className="mt-1 text-[12px] text-muted-foreground">
					{isGenerated
						? "This install still uses the password printed to the server log when it started. Replace it here."
						: "Changing it signs out every other session immediately, which is the point of changing it."}
				</p>
			</CardHeader>
			<CardContent className="flex flex-col gap-4 pt-4">
				<Field>
					<FieldLabel htmlFor="current-password">Current password</FieldLabel>
					<Input
						id="current-password"
						type="password"
						autoComplete="current-password"
						value={current}
						disabled={pending}
						onChange={(event) => setCurrent(event.target.value)}
					/>
				</Field>

				<Field>
					<FieldLabel htmlFor="new-password">New password</FieldLabel>
					<Input
						id="new-password"
						type="password"
						autoComplete="new-password"
						value={next}
						disabled={pending}
						onChange={(event) => setNext(event.target.value)}
					/>
				</Field>

				<Field>
					<FieldLabel htmlFor="confirm-password">Confirm new password</FieldLabel>
					<Input
						id="confirm-password"
						type="password"
						autoComplete="new-password"
						value={confirm}
						disabled={pending}
						onChange={(event) => setConfirm(event.target.value)}
					/>
				</Field>

				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<div>
					<Button type="button" disabled={pending || current === "" || next === "" || confirm === ""} onClick={submit}>
						{pending ? <Spinner className="size-3.5" /> : null}
						Change password
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
