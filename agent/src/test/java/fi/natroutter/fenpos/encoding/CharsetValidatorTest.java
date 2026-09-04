package fi.natroutter.fenpos.encoding;

import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.markup.MarkupParser;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link CharsetValidator}.
 * <p>
 * The codepage cases are chosen from the real difference between the tables: CP437 carries
 * the Nordic vowels but not the euro sign, CP858 carries both. That difference is the whole
 * reason the setting exists.
 */
class CharsetValidatorTest {

    @Test
    void acceptsTextFullyRepresentableInTheCodepage() throws Exception {
        Line line = validate("Hyvaa paivaa", Codepage.CP437, UnsupportedPolicy.REJECT);

        assertEquals("Hyvaa paivaa", line.plainText());
    }

    @Test
    void acceptsNordicVowelsOnCp437() throws Exception {
        assertEquals("Hyvää päivää",
                validate("Hyvää päivää", Codepage.CP437,
                        UnsupportedPolicy.REJECT).plainText());
    }

    @Test
    void rejectsEuroSignOnCp437() {
        UnsupportedCharacterException thrown = assertThrows(UnsupportedCharacterException.class,
                () -> validate("€10", Codepage.CP437, UnsupportedPolicy.REJECT));

        assertEquals("€", thrown.character());
        assertEquals(1, thrown.column());
        assertEquals(Codepage.CP437, thrown.codepage());
    }

    @Test
    void acceptsEuroSignOnCp858() throws Exception {
        assertEquals("€10",
                validate("€10", Codepage.CP858, UnsupportedPolicy.REJECT).plainText());
    }

    /**
     * An emoji is two Java chars. Reporting half a surrogate pair would render as a broken
     * box in the client's error message and identify nothing.
     */
    @Test
    void reportsAstralCharacterAsOneWholeCharacter() {
        UnsupportedCharacterException thrown = assertThrows(UnsupportedCharacterException.class,
                () -> validate("Hello 😎", Codepage.CP858, UnsupportedPolicy.REJECT));

        assertEquals("😎", thrown.character());
        assertEquals(2, thrown.character().length());
        assertEquals(7, thrown.column());
    }

    @Test
    void reportsColumnRelativeToTheOriginalElementIncludingMarkup() {
        UnsupportedCharacterException thrown = assertThrows(UnsupportedCharacterException.class,
                () -> validate("<bold>ab</bold>€", Codepage.CP437, UnsupportedPolicy.REJECT));

        assertEquals(16, thrown.column());
    }

    @Test
    void replacePolicySubstitutesQuestionMark() throws Exception {
        assertEquals("?10", validate("€10", Codepage.CP437, UnsupportedPolicy.REPLACE).plainText());
    }

    @Test
    void stripPolicyRemovesTheCharacter() throws Exception {
        assertEquals("10", validate("€10", Codepage.CP437, UnsupportedPolicy.STRIP).plainText());
    }

    @Test
    void stripPolicyDropsASpanThatBecomesEmpty() throws Exception {
        Line line = validate("<bold>€</bold>ok", Codepage.CP437, UnsupportedPolicy.STRIP);

        assertEquals(1, line.spans().size());
        assertEquals("ok", line.plainText());
    }

    @Test
    void preservesStylingAndDirectives() throws Exception {
        Line line = validate("<bold>ok</bold><feed=2>", Codepage.CP858, UnsupportedPolicy.REJECT);

        assertTrue(line.spans().getFirst().style().bold());
        assertEquals(1, line.directives().size());
    }

    private static Line validate(String markup, Codepage codepage, UnsupportedPolicy policy)
            throws Exception {
        return CharsetValidator.validate(MarkupParser.parse(markup), codepage, policy);
    }

    // -------------------------------------------------------------------------
    // Fills
    // -------------------------------------------------------------------------

    @Test
    void rejectsAFillCharacterTheCodepageCannotRepresent() {
        assertThrows(UnsupportedCharacterException.class,
                () -> CharsetValidator.validate(
                        MarkupParser.parse("a<fill=€>b"), Codepage.CP437, UnsupportedPolicy.REJECT));
    }

    @Test
    void reportsTheFillsOwnColumnWhenItRejectsOne() {
        UnsupportedCharacterException thrown = assertThrows(UnsupportedCharacterException.class,
                () -> CharsetValidator.validate(
                        MarkupParser.parse("a<fill=€>b"), Codepage.CP437, UnsupportedPolicy.REJECT));

        assertEquals(2, thrown.column());
    }

    @Test
    void leavesAPrintableFillCharacterAlone() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("a<fill=.>b"), Codepage.CP437, UnsupportedPolicy.REJECT);

        assertEquals(".", line.fills().getFirst().character());
    }

    @Test
    void leavesAFillsIndexAloneWhenNothingIsDropped() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("a<fill>b"), Codepage.CP437, UnsupportedPolicy.STRIP);

        assertEquals(1, line.fills().getFirst().afterSpans());
    }

    @Test
    void substitutesAFillCharacterUnderTheReplacePolicy() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("a<fill=€>b"), Codepage.CP437, UnsupportedPolicy.REPLACE);

        assertEquals("?", line.fills().getFirst().character());
    }

    @Test
    void dropsAFillWhoseCharacterTheStripPolicyRemoves() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("a<fill=€>b"), Codepage.CP437, UnsupportedPolicy.STRIP);

        assertTrue(line.fills().isEmpty());
    }

    /**
     * {@code afterSpans} indexes a list this pass rewrites. U+0161 is absent from CP437, so
     * stripping it removes the span the fill was recorded against, and without the repair the pad
     * would land on the wrong side of what is left.
     */
    @Test
    void movesAFillPastASpanTheStripPolicyRemoved() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("š<fill>b"), Codepage.CP437, UnsupportedPolicy.STRIP);

        assertEquals(1, line.spans().size());
        assertEquals("b", line.spans().getFirst().text());
        assertEquals(0, line.fills().getFirst().afterSpans());
    }

    /**
     * The boundary the survivors array is one entry longer for: a fill after the <em>last</em> span,
     * whose only preceding span was dropped. Every other case here puts the fill between two spans,
     * so without this one the final entry can be dropped and the suite stays green — while a
     * trailing fill indexes past the end of the array.
     */
    @Test
    void movesATrailingFillPastADroppedSpan() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("š<fill>"), Codepage.CP437, UnsupportedPolicy.STRIP);

        assertTrue(line.spans().isEmpty());
        assertEquals(0, line.fills().getFirst().afterSpans());
    }

    /**
     * The same boundary as above, but with a surviving span before the fill, so the correct answer
     * is not zero. Java zero-initialises int[], which means the previous test alone still passes if
     * the array's final entry is simply never assigned — this one does not.
     */
    @Test
    void movesATrailingFillPastAPartiallyStrippedSpan() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("aš<fill>"), Codepage.CP437, UnsupportedPolicy.STRIP);

        assertEquals(1, line.spans().size());
        assertEquals("a", line.spans().getFirst().text());
        assertEquals(1, line.fills().getFirst().afterSpans());
    }

    /**
     * The other half of the rule: "the remaining fills absorb its slack" needs a fill still standing to
     * absorb it, so every test above — one fill each — leaves it unpinned. Only the character is
     * unprintable here; no span is dropped, so {@code afterSpans} is untouched and the surviving
     * fill's position is the thing this checks.
     */
    @Test
    void keepsTheSurvivingFillWhenTheStripPolicyDropsItsNeighbour() throws Exception {
        Line line = CharsetValidator.validate(
                MarkupParser.parse("a<fill=€>b<fill=.>c"), Codepage.CP437, UnsupportedPolicy.STRIP);

        assertEquals(List.of("a", "b", "c"), line.spans().stream().map(Span::text).toList());
        assertEquals(1, line.fills().size());
        assertEquals(".", line.fills().getFirst().character());
        assertEquals(2, line.fills().getFirst().afterSpans());
    }
}
