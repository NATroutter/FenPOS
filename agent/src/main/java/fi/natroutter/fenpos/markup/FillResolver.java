package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.markup.model.Fill;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;

import java.util.ArrayList;
import java.util.List;

/**
 * Expands {@code <fill>} into the characters it stands for, once the paper's width is known.
 * <p>
 * <b>This is the whole reason the tag exists.</b> Alignment on a thermal printer is {@code ESC a n},
 * which justifies a whole line buffer, so two justifications on one line have no rendering — which
 * is why {@code <align>} must own its line and why a label-left, amount-right row cannot be written
 * with it. Such a row is column layout, column layout on this hardware is padding, and padding needs
 * a column count that belongs to the device. This is the first stage that holds one.
 * <p>
 * Mirrors {@code fenpos/lib/markup/fill.ts}; the two carry the same tests with the same literal
 * expectations.
 */
public final class FillResolver {

    private FillResolver() {
    }

    /**
     * Replaces every fill on a line with the span it stands for.
     *
     * @param line    a parsed line, after the charset pass has settled its characters
     * @param columns the device's printable columns at normal character width
     * @return the line with its fills expanded and {@code fills} empty; the same instance when it
     *         had none
     */
    public static Line resolve(Line line, int columns) {
        if (line.fills().isEmpty()) {
            return line;
        }

        int[] budgets = share(Math.max(0, columns - line.columns()), line.fills().size());
        List<Span> spans = new ArrayList<>(line.spans().size() + line.fills().size());
        int next = 0;

        for (int index = 0; index < line.fills().size(); index++) {
            Fill fill = line.fills().get(index);
            // Fills are recorded in source order and afterSpans never decreases, so the untouched
            // spans before each one can be taken as a sublist rather than searched for.
            spans.addAll(line.spans().subList(next, fill.afterSpans()));
            next = fill.afterSpans();

            // The budget is spent in whole characters, so a fill inside <size=N> can leave up to
            // N - 1 columns unspent and the line lands that much short of the edge. Under the
            // default multiplier of one — every ordinary receipt row — that cannot happen.
            int count = budgets[index] / fill.style().widthMult();
            if (count > 0) {
                spans.add(new Span(fill.character().repeat(count), fill.style(), fill.sourceColumn()));
            }
        }
        spans.addAll(line.spans().subList(next, line.spans().size()));

        return new Line(line.align(), line.wrap(), spans, List.of(), line.directives());
    }

    /**
     * Splits the slack between the fills that share it.
     * <p>
     * The remainder goes to the earliest gaps. Which gap takes it changes nothing about where the
     * line ends — the total handed out is the slack either way — so the rule exists to be
     * deterministic rather than to be right.
     * <p>
     * No special case is needed for more fills than columns: {@code base} is then zero and the first
     * {@code slack} fills take one column each, which is what an evenly split remainder means.
     *
     * @param slack columns left over after the line's text
     * @param count how many fills are sharing them
     * @return one budget per fill, in order, summing to {@code slack}
     */
    private static int[] share(int slack, int count) {
        int base = slack / count;
        int remainder = slack % count;
        int[] budgets = new int[count];
        for (int index = 0; index < count; index++) {
            budgets[index] = base + (index < remainder ? 1 : 0);
        }
        return budgets;
    }
}
