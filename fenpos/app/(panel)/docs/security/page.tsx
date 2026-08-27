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
	] = await Promise.all([
		integerSetting("auth.lockoutAfterFailures"),
		integerSetting("auth.lockoutMinutes"),
		integerSetting("auth.sessionHours"),
		integerSetting("auth.idleTimeoutMinutes"),
		integerSetting("auth.maxConcurrentSessions"),
		booleanSetting("auth.require2fa"),
		stringSetting("auth.ipAllowlist"),
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
								Every row written to the audit record stays. There is no edit control and no delete control anywhere in
								the panel — not on the Audit tab, not for a superuser — and each row's hash chains to the one before it,
								so an edited or deleted row breaks the chain rather than vanishing invisibly.
							</P>

							<P>
								What writes rows is the panel itself, and <Mono>pnpm auth:recover</Mono> below.{" "}
								<strong>The v1 API writes none.</strong> A key that prints a job, cancels one, uploads an asset or
								pauses a device leaves nothing here, and neither does a key refused for a permission it does not hold.
								Jobs and assets keep their own records on their own tabs, so the effects of API traffic are still
								traceable — what the Audit tab cannot answer about it is who did it.
							</P>

							<P>
								The one removal that exists at all is an automatic retention sweep, governed by{" "}
								<Mono>audit.retentionDays</Mono> and <Mono>audit.maxRecords</Mono>, which drops the oldest rows once an
								install exceeds either bound and re-anchors the chain behind whatever it removed — so a routine sweep
								still leaves a chain that verifies clean.
							</P>

							<P>
								<Mono>pnpm audit:verify</Mono> walks the whole chain from a shell on the server and proves it is whole.
								A broken chain names the exact <Mono>seq</Mono> where it broke — the row an investigation starts from —
								and the command cannot repair anything: a tool that offered to fix the chain would be a tool that
								offered to finish the job for whoever broke it.
							</P>
						</Col>

						<Col>
							<CodeBlock label="pnpm audit:verify — chain intact">{`The audit chain is intact: 4218 events verified, seq 1 through 4218.`}</CodeBlock>

							<CodeBlock label="pnpm audit:verify — chain broken">{`THE AUDIT CHAIN IS BROKEN at seq 2091 (hash-mismatch).`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[6]}>
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
