/**
 * The marker on a field whose value has been changed but not saved.
 *
 * A dot rather than a word: on the settings page it appears beside forty-three labels and has to be
 * readable at a glance without being read. `aria-label` because colour and shape carry the whole
 * meaning otherwise.
 *
 * Shared by the settings page and the profile dialog rather than copied into each. Both stage edits
 * and commit them from a footer, so an operator who has learnt what the dot means in one should not
 * have to learn it again in the other — and a second copy is how the two would drift apart.
 *
 * It sits *after* the label it marks, never before: a marker in front indents the word it marks, and
 * a column of labels that shift sideways as you edit them is harder to scan than one that does not.
 */
export function DirtyDot() {
	return <span role="img" aria-label="unsaved" className="size-1.5 shrink-0 rounded-full bg-brand" />;
}
