package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import fi.natroutter.fenpos.markup.model.SpanStyle;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits a line so it fits the paper width.
 * <p>
 * Wrapping works on individual characters rather than on the line's text, because a
 * character's cost in columns depends on the width multiplier of the span it belongs to:
 * under {@code <size=2>} each character occupies two columns, so the same text has to wrap
 * at half the paper width. Measuring {@code String.length()} would overflow the paper on
 * every enlarged line.
 * <p>
 * Breaks are chosen greedily at the last space that still fits. A word longer than the
 * whole width is broken hard, since the alternative is a line that overflows.
 */
public final class LineWrapper {

    private static final char SPACE = ' ';

    private LineWrapper() {
    }

    /**
     * Wraps a line to the given width.
     * <p>
     * Directives are attached to the final fragment only: a cut repeated once per fragment
     * would sever the paper in the middle of the receipt.
     *
     * @param line    the line to wrap
     * @param columns printable columns at normal character width; must be at least 1
     * @return one or more lines in printing order; a line with no text is returned unchanged
     * @throws IllegalArgumentException if {@code columns} is below 1
     */
    public static List<Line> wrap(Line line, int columns) {
        if (columns < 1) {
            throw new IllegalArgumentException("columns must be at least 1, got " + columns);
        }
        if (line.spans().isEmpty()) {
            return List.of(line);
        }

        List<List<Cell>> rows = layOut(flatten(line), columns);
        return toLines(rows, line);
    }

    /** Expands the line's spans into one entry per character, carrying its style forward. */
    private static List<Cell> flatten(Line line) {
        List<Cell> cells = new ArrayList<>();
        for (Span span : line.spans()) {
            String text = span.text();
            for (int offset = 0; offset < text.length(); offset++) {
                cells.add(new Cell(text.charAt(offset), span.style(), span.columnAt(offset)));
            }
        }
        return cells;
    }

    /**
     * Greedily assigns characters to rows.
     * <p>
     * The loop deliberately re-examines the current character after a break rather than
     * advancing, so a character that triggered a break is placed on the new row instead of
     * being lost.
     */
    private static List<List<Cell>> layOut(List<Cell> cells, int columns) {
        List<List<Cell>> rows = new ArrayList<>();
        List<Cell> row = new ArrayList<>();
        int width = 0;
        int lastSpace = -1;

        int index = 0;
        while (index < cells.size()) {
            Cell cell = cells.get(index);

            // Whitespace left over from a break would indent the continuation.
            if (row.isEmpty() && !rows.isEmpty() && cell.isSpace()) {
                index++;
                continue;
            }

            if (cell.isSpace()) {
                if (width + cell.cost() > columns) {
                    // The space itself is the break point, so it is consumed rather than
                    // carried to the next row.
                    rows.add(row);
                    row = new ArrayList<>();
                    width = 0;
                    lastSpace = -1;
                    index++;
                    continue;
                }
                lastSpace = row.size();
            } else if (!row.isEmpty() && width + cell.cost() > columns) {
                if (lastSpace >= 0) {
                    // Everything after the last space is an unfinished word: move it down.
                    List<Cell> carried = new ArrayList<>(row.subList(lastSpace + 1, row.size()));
                    rows.add(new ArrayList<>(row.subList(0, lastSpace)));
                    row = carried;
                    width = widthOf(carried);
                } else {
                    // A word wider than the paper: break it rather than overflow.
                    rows.add(row);
                    row = new ArrayList<>();
                    width = 0;
                }
                lastSpace = -1;
                continue;
            }

            row.add(cell);
            width += cell.cost();
            index++;
        }
        rows.add(row);

        return trim(rows);
    }

    /**
     * Removes trailing spaces from every row, then drops rows left empty at the end.
     * <p>
     * Trailing spaces are invisible on paper but consume columns, so keeping them would
     * push a following word onto a new line for no reason. At least one row always
     * survives, so a line of nothing but spaces still prints as one blank line.
     */
    private static List<List<Cell>> trim(List<List<Cell>> rows) {
        for (List<Cell> row : rows) {
            while (!row.isEmpty() && row.getLast().isSpace()) {
                row.removeLast();
            }
        }
        while (rows.size() > 1 && rows.getLast().isEmpty()) {
            rows.removeLast();
        }
        return rows;
    }

    /** Rebuilds lines from rows, merging neighbouring characters that share a style. */
    private static List<Line> toLines(List<List<Cell>> rows, Line source) {
        List<Line> lines = new ArrayList<>(rows.size());
        for (int index = 0; index < rows.size(); index++) {
            boolean last = index == rows.size() - 1;
            lines.add(new Line(
                    source.align(),
                    source.wrap(),
                    toSpans(rows.get(index)),
                    last ? source.directives() : List.of()));
        }
        return lines;
    }

    private static List<Span> toSpans(List<Cell> row) {
        List<Span> spans = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        SpanStyle style = null;
        int startColumn = 1;

        for (Cell cell : row) {
            if (style != null && !style.equals(cell.style())) {
                spans.add(new Span(text.toString(), style, startColumn));
                text.setLength(0);
            }
            if (text.isEmpty()) {
                style = cell.style();
                startColumn = cell.sourceColumn();
            }
            text.append(cell.character());
        }
        if (!text.isEmpty()) {
            spans.add(new Span(text.toString(), style, startColumn));
        }
        return spans;
    }

    private static int widthOf(List<Cell> cells) {
        return cells.stream().mapToInt(Cell::cost).sum();
    }

    /**
     * One character together with everything needed to place and re-assemble it.
     *
     * @param character    the character itself
     * @param style        the style inherited from its span
     * @param sourceColumn where it came from in the original element
     */
    private record Cell(char character, SpanStyle style, int sourceColumn) {

        /** Returns the columns this character occupies when printed. */
        int cost() {
            return style.widthMult();
        }

        boolean isSpace() {
            return character == SPACE;
        }
    }
}
