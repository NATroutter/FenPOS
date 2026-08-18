package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.markup.model.Line;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link LineWrapper}.
 * <p>
 * Widths here are deliberately small so the expected break points can be read off the
 * input by eye rather than counted.
 */
class LineWrapperTest {

    @Test
    void leavesALineThatFitsUntouched() throws Exception {
        List<Line> wrapped = wrap("Kahvi 2.50", 32);

        assertEquals(1, wrapped.size());
        assertEquals("Kahvi 2.50", wrapped.getFirst().plainText());
    }

    @Test
    void breaksAtTheSpaceBeforeExceedingTheWidth() throws Exception {
        List<Line> wrapped = wrap("aaa bbb ccc", 7);

        assertEquals(List.of("aaa bbb", "ccc"), plainTexts(wrapped));
    }

    @Test
    void dropsTheSpaceAtTheBreakPoint() throws Exception {
        List<Line> wrapped = wrap("aaaa bbbb", 4);

        assertEquals(List.of("aaaa", "bbbb"), plainTexts(wrapped));
    }

    @Test
    void hardBreaksAWordLongerThanTheWidth() throws Exception {
        List<Line> wrapped = wrap("aaaaaaaaaa", 4);

        assertEquals(List.of("aaaa", "aaaa", "aa"), plainTexts(wrapped));
    }

    @Test
    void dropsLeadingWhitespaceOnAContinuation() throws Exception {
        List<Line> wrapped = wrap("aaaa      bbbb", 4);

        assertEquals(List.of("aaaa", "bbbb"), plainTexts(wrapped));
    }

    /**
     * The reason wrapping walks spans rather than a plain string: a double-width character
     * occupies two columns, so the same text wraps at half the paper width.
     */
    @Test
    void doubleWidthTextWrapsAtHalfTheColumns() throws Exception {
        List<Line> wrapped = wrap("<size=2>HELLO WORLD</size>", 20);

        assertEquals(List.of("HELLO", "WORLD"), plainTexts(wrapped));
    }

    @Test
    void singleWidthTextOfTheSameLengthDoesNotWrapAtThatWidth() throws Exception {
        assertEquals(List.of("HELLO WORLD"), plainTexts(wrap("HELLO WORLD", 20)));
    }

    @Test
    void preservesStyleAcrossABreak() throws Exception {
        List<Line> wrapped = wrap("<bold>aaaa bbbb</bold>", 4);

        assertEquals(2, wrapped.size());
        assertTrue(wrapped.get(0).spans().getFirst().style().bold());
        assertTrue(wrapped.get(1).spans().getFirst().style().bold());
    }

    @Test
    void keepsAStyleBoundaryThatFallsInsideAFragment() throws Exception {
        List<Line> wrapped = wrap("<bold>ab</bold>cd ef", 4);

        assertEquals(List.of("abcd", "ef"), plainTexts(wrapped));
        assertEquals(2, wrapped.getFirst().spans().size());
        assertTrue(wrapped.getFirst().spans().get(0).style().bold());
        assertFalse(wrapped.getFirst().spans().get(1).style().bold());
    }

    @Test
    void mergesNeighbouringTextOfEqualStyleIntoOneSpan() throws Exception {
        List<Line> wrapped = wrap("a&lt;b", 32);

        assertEquals(1, wrapped.size());
        assertEquals(1, wrapped.getFirst().spans().size(), "equal styles should collapse");
        assertEquals("a<b", wrapped.getFirst().plainText());
    }

    @Test
    void everyFragmentInheritsTheLineAlignment() throws Exception {
        List<Line> wrapped = wrap("<align=center>aaaa bbbb</align>", 4);

        assertEquals(2, wrapped.size());
        wrapped.forEach(line -> assertEquals(Align.CENTER, line.align()));
    }

    /**
     * A cut must happen once, after the last fragment. Repeating it per fragment would cut
     * the paper in the middle of the receipt.
     */
    @Test
    void directivesAttachToTheLastFragmentOnly() throws Exception {
        List<Line> wrapped = wrap("aaaa bbbb<feed=2>", 4);

        assertEquals(2, wrapped.size());
        assertTrue(wrapped.get(0).directives().isEmpty());
        assertEquals(1, wrapped.get(1).directives().size());
    }

    @Test
    void passesThroughADirectiveOnlyLine() throws Exception {
        Line source = MarkupParser.parse("<cut>");
        List<Line> wrapped = LineWrapper.wrap(source, 32);

        assertEquals(1, wrapped.size());
        assertSame(source, wrapped.getFirst());
    }

    @Test
    void passesThroughAnEmptyLine() throws Exception {
        Line source = MarkupParser.parse("");
        List<Line> wrapped = LineWrapper.wrap(source, 32);

        assertEquals(1, wrapped.size());
        assertSame(source, wrapped.getFirst());
    }

    /**
     * Guards the wrapping loop: a character wider than the whole paper must still be
     * emitted, or the wrapper would make no progress and spin forever.
     */
    @Test
    void emitsACharacterThatIsWiderThanTheWholeLine() throws Exception {
        List<Line> wrapped = wrap("<size=8>ab</size>", 4);

        assertEquals(List.of("a", "b"), plainTexts(wrapped));
    }

    @Test
    void collapsesALineOfOnlySpacesToNothing() throws Exception {
        List<Line> wrapped = wrap("     ", 4);

        assertEquals(1, wrapped.size());
        assertEquals("", wrapped.getFirst().plainText());
    }

    private static List<Line> wrap(String markup, int columns) throws Exception {
        return LineWrapper.wrap(MarkupParser.parse(markup), columns);
    }

    private static List<String> plainTexts(List<Line> lines) {
        return lines.stream().map(Line::plainText).toList();
    }
}
