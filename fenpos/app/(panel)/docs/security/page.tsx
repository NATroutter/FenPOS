import type { ReactNode } from "react";
import { CodeBlock } from "@/app/(panel)/docs/code-block";
import { ContentsRail } from "@/app/(panel)/docs/contents-rail";
import { DocSection } from "@/app/(panel)/docs/doc-section";
import { Aside, Col, Mono, P, Split } from "@/app/(panel)/docs/prose";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { booleanSetting, integerSetting, stringSetting } from "@/lib/settings/settings-service";

export const metadata = { title: "Security" };

/** Never cached: several sentences below quote this install's own configured numbers. */
export const dynamic = "force-dynamic";

/**
 * The sections, declared once.
 *
 * The contents rail and the sections themselves both read this, so a heading cannot be renamed
 * into a rail entry that no longer matches it or an anchor that goes nowhere — the same reasoning
 * the API and markup pages give for the same pattern.
 */
const SECTIONS = [
	{ id: "signing-in", title: "Signing in", note: "A password, then a code where one is enrolled" },
	{ id: "two-factor", title: "Two-factor", note: "Enrolling, recovery codes, and losing both" },
	{ id: "requiring-two-factor", title: "Requiring two-factor", note: "auth.require2fa and its one real risk" },
	{ id: "sessions", title: "Sessions", note: "Lifetime, inactivity, and how many at once" },
	{ id: "allowlist", title: "The address allowlist", note: "auth.ipAllowlist, checked on every request" },
	{ id: "audit", title: "The audit record", note: "Append-only, and how to prove it" },
	{ id: "archives", title: "Archived history", note: "Where a month goes when it ages out, and who may remove one" },
	{
		id: "profile-images",
		title: "Profile images",
		note: "Where an avatar lives, who may see one, and who may change another's",
	},
	{ id: "recovering", title: "Recovering", note: "pnpm auth:recover, for an install nobody can sign in to" },
] as const;

/** One row of a {@link Facts} panel: a setting's label beside its current value on this install. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
			<span className="rounded border border-border bg-muted/60 px-1.5 py-px font-mono text-[11px] text-foreground">
				{label}
			</span>
			<span className="min-w-0 flex-1 text-[12px] text-muted-foreground">{children}</span>
		</div>
	);
}

/**
 * A bordered list of {@link Fact} rows.
 *
 * The same shape the API page uses for its permission list — a reader comparing two reference
 * pages should not have to learn a second layout for "here is a short list of labelled facts".
 */
function Facts({ children }: { children: ReactNode }) {
	return (
		<div className="min-w-0 divide-y divide-border overflow-hidden rounded-lg border border-border">{children}</div>
	);
}

/**
 * The Security tab of the panel's own documentation.
 *
 * Written against this install rather than in the abstract, the way the API and markup pages
 * already are: several sentences below quote the actual value a setting is configured to right
 * now, not just what the setting does in general, so an operator reading this page never has to
 * cross-check it against the Settings tab to know where they stand.
 *
 * **Every claim here has to be true of the code as it stands.** This page exists because an
 * operator locked out of their own install is reading it under pressure, and a sentence that was
 * true when it was written and false by the time anyone needed it is worse than no sentence at
 * all — the same discipline the API and markup pages hold their own claims to.
 */
export default async function SecurityDocsPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("docs:read", "/docs/security");

	const [
		lockoutAfterFailures,
		lockoutMinutes,
		sessionHours,
		idleTimeoutMinutes,
		maxConcurrentSessions,
		require2fa,
		ipAllowlist,
		auditRetentionDays,
		logArchiveEnabled,
		logArchiveRetentionDays,
	] = await Promise.all([
		integerSetting("auth.lockoutAfterFailures"),
		integerSetting("auth.lockoutMinutes"),
		integerSetting("auth.sessionHours"),
		integerSetting("auth.idleTimeoutMinutes"),
		integerSetting("auth.maxConcurrentSessions"),
		booleanSetting("auth.require2fa"),
		stringSetting("auth.ipAllowlist"),
		integerSetting("audit.retentionDays"),
		booleanSetting("logs.archiveEnabled"),
		integerSetting("logs.archiveRetentionDays"),
	]);

	return (
		<div className="grid w-full gap-6 xl:grid-cols-[minmax(0,1fr)_210px] xl:items-start">
			<div className="flex min-w-0 flex-col gap-3">
				<DocSection {...SECTIONS[0]}>
					<Split>
						<Col>
							<P>
								Every sign-in starts with a password. An account with an authenticator enrolled is then asked for a
								six-digit code from it, or one of its recovery codes, on the same field — the two are told apart by
								shape, not by asking which kind is coming.
							</P>

							<P>
								<Mono>auth.lockoutAfterFailures</Mono> and <Mono>auth.lockoutMinutes</Mono> govern the password step:{" "}
								{lockoutAfterFailures === 0 ? (
									<>
										this install does not lock an account for wrong passwords — <Mono>auth.lockoutAfterFailures</Mono>{" "}
										is currently 0, which turns that lock off entirely.
									</>
								) : (
									<>
										on this install, <strong>{lockoutAfterFailures}</strong> consecutive wrong passwords lock the
										account for <strong>{lockoutMinutes}</strong> minutes. The lock clears itself; nobody has to undo
										it, though <Mono>pnpm auth:recover --unlock</Mono>, below, ends it early.
									</>
								)}{" "}
								This is separate from the per-address throttle that limits how fast anyone may try passwords at all,
								which stays on regardless of this setting.
							</P>

							<Aside>
								An account with an authenticator carries a second lock that no setting on this install controls: five
								wrong codes on one challenge require a fresh one to be requested, and ten consecutive wrong
								verifications lock the account for fifteen minutes — better-auth's own default, unrelated to{" "}
								<Mono>auth.lockoutAfterFailures</Mono> and <Mono>auth.lockoutMinutes</Mono> above, which govern the
								password step only.
							</Aside>
						</Col>

						<Facts>
							<Fact label="auth.lockoutAfterFailures">
								{lockoutAfterFailures === 0 ? "0 — never locks this way" : `${lockoutAfterFailures} attempts`}
							</Fact>
							<Fact label="auth.lockoutMinutes">{lockoutMinutes} minutes</Fact>
							<Fact label="Two-factor lockout (built in)">10 consecutive failures, 15 minutes</Fact>
						</Facts>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[1]}>
					<Split>
						<Col>
							<P>
								Enrolling is voluntary unless Requiring two-factor, below, is on. From the account menu in the sidebar,
								open <strong>Profile settings</strong>, then <strong>Two-factor</strong>, and scan the QR code with an
								authenticator app.
							</P>

							<P>
								Ten recovery codes are shown once, at the moment enrolment is confirmed, and never again after that
								screen closes. They are stored <strong>encrypted</strong>, not hashed — a hash could never be turned
								back into a code to display, and this panel has no screen that decrypts one either, which is the honest
								reason a lost set cannot be recovered by looking rather than a limitation nobody got around to lifting.
							</P>

							<P>
								Losing both the phone and the codes leaves one way back in: another administrator holding{" "}
								<Mono>users:disable-2fa</Mono> clears the enrolment from the Users tab, or — on a server nobody can
								reach the panel from at all — <Mono>pnpm auth:recover --clear-2fa &lt;email&gt;</Mono> does the same
								thing outside it. Either way the account signs in on its password alone afterward and can enrol again.
							</P>
						</Col>

						<Facts>
							<Fact label="Recovery codes">10, shown once, at confirmation</Fact>
							<Fact label="Storage">Encrypted — no screen decrypts them again</Fact>
							<Fact label="Lost both factors">An administrator, or the recovery CLI</Fact>
						</Facts>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[2]}>
					<Split>
						<Col>
							<P>
								<Mono>auth.require2fa</Mono> is currently <strong>{require2fa ? "on" : "off"}</strong>.{" "}
								{require2fa
									? "Every account must carry an authenticator before it can reach anything past sign-in."
									: "No account on this install is currently required to enrol."}
							</P>

							<P>
								Turning it on does not lock anyone out by itself: an account with no enrolment still signs in on its
								password alone and is sent straight to the enrolment screen instead of the dashboard, rather than being
								refused at the door.
							</P>

							<Aside>
								<strong>The one real risk this setting carries:</strong> on an install with a single administrator, that
								account losing both its phone and its recovery codes while this is on needs server access to recover.
								There is no second administrator to clear the enrolment from the Users tab, and no panel screen reaches
								an account this stuck — only <Mono>pnpm auth:recover --clear-2fa</Mono> or <Mono>--reset-password</Mono>
								, run by whoever can already open the database directly. Turning this on for a single-administrator
								install is a decision to keep server access available, not just a panel setting.
							</Aside>
						</Col>

						<Facts>
							<Fact label="auth.require2fa">{require2fa ? "on" : "off"}</Fact>
							<Fact label="Un-enrolled account, once on">Sent to enrol, not refused</Fact>
							<Fact label="Both factors lost, one administrator">Needs server access</Fact>
						</Facts>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[3]}>
					<Split>
						<Col>
							<P>
								<Mono>auth.sessionHours</Mono>, set to <strong>{sessionHours}</strong> hours on this install, is an{" "}
								<strong>absolute</strong> lifetime. The clock starts at sign-in and is not extended by use — a session
								created just before its deadline ends there however busy it was in between, and nothing short of signing
								in again moves that deadline out.
							</P>

							<P>
								<Mono>auth.idleTimeoutMinutes</Mono> is a separate, independent clock:{" "}
								{idleTimeoutMinutes === 0 ? (
									<>it is currently off, so a quiet session is never ended for sitting still.</>
								) : (
									<>
										a session left untouched for <strong>{idleTimeoutMinutes}</strong> minutes on this install is ended,
										whatever the lifetime above still has left.
									</>
								)}
							</P>

							<P>
								<Mono>auth.maxConcurrentSessions</Mono> (
								{maxConcurrentSessions === 0 ? "unlimited on this install" : `${maxConcurrentSessions} on this install`}
								) bounds how many places one account may be signed in at once. Reaching it retires the account's{" "}
								<strong>least recently used</strong> session rather than refusing the new sign-in — a browser that
								crashed loses its place instead of locking its owner out of a fresh one.
							</P>
						</Col>

						<Facts>
							<Fact label="auth.sessionHours">{sessionHours} hours, absolute</Fact>
							<Fact label="auth.idleTimeoutMinutes">
								{idleTimeoutMinutes === 0 ? "0 — never ends one this way" : `${idleTimeoutMinutes} minutes`}
							</Fact>
							<Fact label="auth.maxConcurrentSessions">
								{maxConcurrentSessions === 0 ? "0 — unlimited" : `${maxConcurrentSessions}, oldest use evicted first`}
							</Fact>
						</Facts>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[4]}>
					<Split>
						<Col>
							<P>
								<Mono>auth.ipAllowlist</Mono> names addresses and CIDR ranges allowed to sign in, and is{" "}
								{ipAllowlist.trim() === "" ? (
									<>empty on this install right now, which means every address is allowed.</>
								) : (
									<>configured on this install.</>
								)}{" "}
								It is checked at sign-in, and again on <strong>every</strong> panel request afterward — tightening it
								ends a session that no longer qualifies rather than waiting for that account's next sign-in.
							</P>

							<Aside>
								A wrong entry locks out its own author along with everyone else outside the range it names, and there is
								no panel screen left to fix it from once that happens. <Mono>pnpm auth:recover --clear-allowlist</Mono>{" "}
								empties it from a shell on the server — the same way <Mono>--clear-2fa</Mono> and{" "}
								<Mono>--reset-password</Mono>, above, recover the other two ways an install can lock itself out.
							</Aside>
						</Col>

						<Facts>
							<Fact label="auth.ipAllowlist">
								{ipAllowlist.trim() === "" ? "Empty — unrestricted" : "Configured on this install"}
							</Fact>
							<Fact label="Checked">At sign-in, and again on every request</Fact>
							<Fact label="Wrong entry, no way in">pnpm auth:recover --clear-allowlist</Fact>
						</Facts>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[5]}>
					<Split>
						<Col>
							<P>
								Every row written to the audit record stays. There is no path in this codebase that edits one and none
								that picks a row out to delete, and each row's hash chains to the one before it, so an edited or removed
								row breaks the chain rather than vanishing invisibly. The Audit tab carries no edit or delete control at
								all, not for a superuser either. What can leave the live database is a whole calendar month at a time,
								into an archive; what can leave the record altogether is one of those archives, deleted on purpose.
								Archived history, below, is both.
							</P>

							<P>
								What writes rows is the panel itself, and <Mono>pnpm auth:recover</Mono> below.{" "}
								<strong>The v1 API writes none.</strong> A key that prints a job, cancels one, uploads an asset or
								pauses a device leaves nothing here, and neither does a key refused for a permission it does not hold.
								Those requests are recorded on the Logs tab instead: every refusal, everything that changed something,
								and successful reads too where <Mono>logs.recordApiReads</Mono> is on. Each line names the key that made
								it, unless the request was turned away before any key was resolved — a bad token names nobody. So what
								an API key did is answerable there rather than here.
							</P>

							<P>
								The one removal that happens on its own — as against an archive somebody deletes — is retention,
								governed by <Mono>audit.retentionDays</Mono> (<strong>{auditRetentionDays}</strong> days on this
								install), and it never deletes an event that has not been archived first. A whole calendar month is
								copied into an archive file, the copy is checked — its row count against what was read, and its hash
								chain walked end to end — and only then are those rows removed from the live database and the chain
								re-anchored behind them. Because an archive is named for a month, only a month that has fully aged out
								may go, so up to a month more than the window is kept.
							</P>

							<P>
								<Mono>pnpm audit:verify</Mono> walks the whole record from a shell on the server — the archives first,
								then the rows still live — and answers one of three ways. It cannot repair anything: a tool that offered
								to fix the chain would be a tool that offered to finish the job for whoever broke it.
							</P>

							<P>
								<strong>Intact</strong> means everything it holds verified, and the count says how much of that came out
								of archives rather than the live database. <strong>Intact from a seq</strong> is Archived history,
								below. <strong>Broken</strong> names the exact <Mono>seq</Mono> it broke at and which of five ways: a
								row that no longer matches its own hash, a row whose link no longer matches the row before it, an anchor
								that disagrees with the oldest row left, archives and the live database disagreeing about where the
								archived history ends, or an archive that should be on disk and is not. That <Mono>seq</Mono> is where
								an investigation starts. Only a break is reported as a failure — the other two answers exit 0 — so a
								monitoring check can run this unattended.
							</P>

							<P>
								The <strong>Verify chain</strong> button on the Audit tab runs the same walk over the same files and
								shows the same sentence, for an account holding <Mono>audit:verify</Mono>.
							</P>
						</Col>

						<Col>
							<CodeBlock label="pnpm audit:verify — chain intact">
								{`The audit chain is intact: 4218 events verified, seq 1 through 4218 (3800 from archives, 418 live).`}
							</CodeBlock>

							<CodeBlock label="pnpm audit:verify — intact as far back as the record goes">
								{`The audit chain is intact from seq 1402: 2817 events verified (2399 from archives, 418 live).

Events before seq 1402 were removed by retention before archiving was in use.
They cannot be verified, and nothing here suggests they were altered — they are simply gone.`}
							</CodeBlock>

							<CodeBlock label="pnpm audit:verify — chain broken">{`THE AUDIT CHAIN IS BROKEN at seq 2091 (hash-mismatch).
2090 events before it verified.

This means the record was changed after it was written. Nothing here can repair it, and
nothing should: seq 2091 is where an investigation starts.`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[6]}>
					<Split>
						<Col>
							<P>
								An archived month is the same rows in a compressed SQLite file — <Mono>audit-2026-01.db.gz</Mono> — in
								an <Mono>archives</Mono> directory beside the databases themselves, on whatever volume they are on. The{" "}
								<strong>Archives</strong> tab lists what is there and searches inside one: an audit month needs{" "}
								<Mono>audit:read</Mono> and a log month <Mono>logs:read</Mono>, and either one on its own opens the tab
								and shows that source's months. A range on the Logs tab that reaches back before the live window says so
								and points at the archive covering it, when there is one on disk.
							</P>

							<P>
								Verification reaches into those files, so an archived month is proved rather than trusted. What it
								cannot reach is history that left before archiving existed: an install upgraded from an earlier version
								swept rows straight out of the database, and those rows are in no file. The record keeps the{" "}
								<Mono>seq</Mono> archiving is complete from, and a verification that starts there reports{" "}
								<strong>intact from</strong> that <Mono>seq</Mono> rather than claiming the whole chain.
							</P>

							<Aside>
								<strong>That answer is a correctly configured install, not an incident.</strong> Everything from that{" "}
								<Mono>seq</Mono> on is proved, nothing suggests the rows before it were altered, and they are simply
								gone. <Mono>pnpm audit:verify</Mono> exits <strong>0</strong> on it and the Audit tab draws it as a note
								rather than a warning — the alternative is paging somebody hourly, for the life of the install, about a
								retention setting doing its job.
							</Aside>

							<P>
								Log archives are deleted by age, on the same pass that writes them, once the month one covers has been
								over for <Mono>logs.archiveRetentionDays</Mono> (<strong>{logArchiveRetentionDays}</strong> days here).{" "}
								<strong>Audit archives are never deleted on a timer.</strong> They are evidence, and a timer that
								removed evidence is one an attacker could wait for rather than defeat.
							</P>

							<P>
								An operator who needs the space deletes one from the Archives tab, which needs{" "}
								<Mono>audit:archive-delete</Mono> — held apart from <Mono>audit:read</Mono> because this destroys
								evidence rather than reading it. Only the oldest archived month may go, and never the last one on disk.
								The record's own note of where archived history begins moves to the month that becomes the oldest in the
								same operation, so the next verification says the record begins later instead of reporting a file as
								missing, and the deletion writes its own row into the record it shortens.
							</P>

							<Aside>
								A rotation whose compression failed leaves an uncompressed <Mono>audit-&lt;month&gt;.db</Mono> beside
								the rest. While one is on disk the delete refuses outright, whichever month was asked for: that file is
								one verification reads and the tab's own listing cannot see, so "the oldest" would mean two different
								things to the two of them.
							</Aside>
						</Col>

						<Facts>
							<Fact label="audit.retentionDays">{auditRetentionDays} days, and the month that cutoff falls in</Fact>
							<Fact label="logs.archiveEnabled">
								{logArchiveEnabled ? "On — aged-out lines are archived first" : "Off — aged-out lines are deleted"}
							</Fact>
							<Fact label="logs.archiveRetentionDays">
								{logArchiveRetentionDays} days past the month it covers, then the file goes
							</Fact>
							<Fact label="Audit archives">Deleted only by hand, under audit:archive-delete</Fact>
						</Facts>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[7]}>
					<Split>
						<Col>
							<P>
								An avatar lives in this install's own database — the upload as received, the crop rectangle chosen
								against it, and a <strong>512px square</strong> render baked from the two — and nothing about a picture
								is ever fetched from anywhere else. There is no Gravatar lookup left in this codebase: an account's
								email address is never hashed and sent to a third party to find a picture for it, which also means a
								picture can be set on an install with no outbound internet access at all. An account with nothing set
								draws its initial instead, from its display name.
							</P>

							<P>
								The render is served from <Mono>GET /api/avatar/&lt;userId&gt;</Mono>, which requires a session and no
								permission beyond it — any signed-in account may fetch any other account's avatar, because the Users tab
								already shows every operator's name and address to anyone who can open it, and gating the image
								separately would just draw broken pictures beside names the viewer is already allowed to read. "A
								session" means one that passes every gate a panel page applies, the address allowlist and the inactivity
								timeout included, not merely a cookie that still resolves. An unauthenticated request is refused
								outright.
							</P>

							<P>
								Setting or removing your <strong>own</strong> avatar, from Profile settings in the account menu, is
								ungated the way changing your own name or password is — every signed-in account may do it. Changing{" "}
								<strong>another</strong> account's avatar is different: it needs <Mono>users:update</Mono>, the same
								permission that governs that account's name and email, and it is reachable only from the Users tab. The
								original is kept rather than discarded once a render is baked, so that a later re-crop can start from
								the picture as uploaded rather than from an already-cropped square. Changing a crop today means choosing
								the picture again: the dialog works from the file you pick, and re-cropping what is already stored is
								not built yet.
							</P>

							<Aside>
								Setting and removing an avatar are each audited separately, on success and on refusal alike, and there
								is a distinct entry for the ungated pair on your own account and the <Mono>users:update</Mono>-gated
								pair on someone else's — so a row says both what happened and whether it was done to the acting account
								or another one. The row never carries the image bytes themselves: an avatar is megabytes and an audit
								row is a permanent, hash-chained record, so what it keeps is the crop and, for the administrator pair,
								which account was changed.
							</Aside>
						</Col>

						<Facts>
							<Fact label="Storage">This install's own database — original, crop, and 512px render</Fact>
							<Fact label="Third-party lookups">None — Gravatar is gone</Fact>
							<Fact label={"GET /api/avatar/<userId>"}>Every session gate applies; no permission gate</Fact>
							<Fact label="Your own avatar">Ungated, like your own name and password</Fact>
							<Fact label="Another account's avatar">users:update, from the Users tab</Fact>
							<Fact label="Audited">Every set and remove, on both accounts — success and refusal alike</Fact>
						</Facts>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[8]}>
					<Split>
						<Col>
							<P>
								With no email and first-run setup permanently sealed, a forgotten superuser password would otherwise
								brick the install for good — and <Mono>auth.require2fa</Mono> can do the same to an administrator who
								loses both a phone and its recovery codes. <Mono>pnpm auth:recover</Mono> exists for exactly that: a
								shell command that reads five actions from the flag it is given.
							</P>

							<P>
								<Mono>--list</Mono> prints every account's email, name, superuser status, two-factor status, ban and
								lockout, so an operator can see who they are about to act on before doing anything. The ban is on that
								line because it is the one refusal there that no command below lifts: a banned account with a freshly
								reset password still cannot sign in, and only the Users tab changes that.
							</P>

							<P>
								<Mono>--reset-password &lt;email&gt;</Mono> mints a password nobody chose, prints it once, forces the
								account to set a new one at its very next sign-in, and ends every session it currently holds — a printed
								password cannot be typed in behind a session that is still live on someone else's screen.
							</P>

							<P>
								<Mono>--clear-2fa &lt;email&gt;</Mono> and <Mono>--unlock &lt;email&gt;</Mono> clear an enrolment or a
								lockout the same way the Users tab and the lockout's own <strong>{lockoutMinutes}</strong>-minute clock
								would, respectively — outside the panel, for the install where nobody can reach the panel at all.{" "}
								<Mono>--clear-allowlist</Mono> empties <Mono>auth.ipAllowlist</Mono>, the third way this install can
								lock everyone out of itself.
							</P>

							<P>
								<Mono>--unlock</Mono> ends the <strong>password</strong> lockout and only that one. The second, built-in
								two-factor lock described under Signing in — ten wrong codes, fifteen minutes, governed by no setting on
								this install — is untouched by it. An administrator locked out that way is reached only by{" "}
								<Mono>--clear-2fa</Mono>, which ends the lock by destroying the enrolment behind it.
							</P>

							<Aside>
								Running any of this needs a shell on the server — reading <Mono>DATABASE_URL</Mono> and opening the
								database file directly, access strictly stronger than anything the panel itself checks. That is the
								whole safety argument: it grants nothing to anyone who could not already read the database with a SQL
								client and do the same thing by hand. Every operation but <Mono>--list</Mono> writes an audit row,
								success or refusal alike — a refusal run against a box nobody can sign in to is more interesting than a
								success, since a human stands behind a success and can be asked what they did.
							</Aside>
						</Col>

						<Col>
							<CodeBlock label="Usage">{`pnpm auth:recover --list
pnpm auth:recover --reset-password <email>
pnpm auth:recover --clear-2fa <email>
pnpm auth:recover --unlock <email>
pnpm auth:recover --clear-allowlist`}</CodeBlock>

							<CodeBlock label="pnpm auth:recover --reset-password admin@example.com">{`Xk9m_2vQ… (171 characters, shown once)
This password is shown once and cannot be recovered; the account must set a new one at its next sign-in.`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>
			</div>

			<ContentsRail sections={SECTIONS} />
		</div>
	);
}
