package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link MarkupParser}.
 * <p>
 * Error tests assert the reported column as well as the error kind, because the column is
 * the part clients actually use to point a user at their mistake, and it is the part most
 * easily broken by a refactor.
 */
class MarkupParserTest {

    /**
     * Text carrying a raw {@code ESC} at column 3. Built from a char code rather than a
     * string literal so the control byte stays visible to anyone reading this file.
     */
    private static final String ESCAPE_IN_TEXT = "ab" + (char) 0x1B + "c";

    // -------------------------------------------------------------------------
    // Text and entities
    // -------------------------------------------------------------------------

    @Test
    void parsesPlainTextAsOneUnstyledSpan() throws Exception {
        Line line = MarkupParser.parse("Kahvi 2.50");

        assertEquals(1, line.spans().size());
        assertEquals("Kahvi 2.50", line.spans().getFirst().text());
        assertFalse(line.spans().getFirst().style().bold());
        assertEquals(Align.LEFT, line.align());
    }

    @Test
    void parsesEmptyElementAsBlankLine() throws Exception {
        Line line = MarkupParser.parse("");

        assertTrue(line.spans().isEmpty());
        assertTrue(line.directives().isEmpty());
        assertFalse(line.isDirectiveOnly());
    }

    @Test
    void decodesEntitiesIntoLiteralCharacters() throws Exception {
        Line line = MarkupParser.parse("a &lt; b &amp; c");

        assertEquals("a < b & c", line.plainText());
    }

    @Test
    void treatsAmpersandThatStartsNoEntityAsLiteral() throws Exception {
        assertEquals("Fish & Chips 50% &x", MarkupParser.parse("Fish & Chips 50% &x").plainText());
    }

    /**
     * Spans carry where they started so a later stage can report an exact column. Markup
     * consumes source characters that produce no text, so the offset cannot be recovered
     * from the parsed text alone.
     */
    @Test
    void spansRecordTheirSourceColumn() throws Exception {
        Line line = MarkupParser.parse("<bold>ab</bold>cd");

        assertEquals(7, line.spans().get(0).sourceColumn());
        assertEquals(16, line.spans().get(1).sourceColumn());
    }

    /**
     * An entity occupies more source characters than it produces, so it is isolated into
     * its own span; otherwise every column after it in the same span would be wrong.
     */
    @Test
    void entityBecomesItsOwnSpanSoLaterColumnsStayExact() throws Exception {
        Line line = MarkupParser.parse("a&lt;b");

        assertEquals(3, line.spans().size());
        assertEquals(1, line.spans().get(0).sourceColumn());
        assertEquals(2, line.spans().get(1).sourceColumn());
        assertEquals(6, line.spans().get(2).sourceColumn());
        assertEquals("a<b", line.plainText());
    }

    // -------------------------------------------------------------------------
    // Styling
    // -------------------------------------------------------------------------

    @Test
    void appliesBoldToEnclosedTextOnly() throws Exception {
        Line line = MarkupParser.parse("<bold>Total:</bold> 12.30");

        assertEquals(2, line.spans().size());
        assertEquals("Total:", line.spans().get(0).text());
        assertTrue(line.spans().get(0).style().bold());
        assertEquals(" 12.30", line.spans().get(1).text());
        assertFalse(line.spans().get(1).style().bold());
    }

    @Test
    void appliesNestedTagsCumulatively() throws Exception {
        Line line = MarkupParser.parse("<bold><underline>x</underline></bold>");

        Span span = line.spans().getFirst();
        assertTrue(span.style().bold());
        assertEquals(1, span.style().underline());
    }

    @Test
    void parsesSizeArgumentsAsSeparateMultipliers() throws Exception {
        Line line = MarkupParser.parse("<size=2,3>BIG</size>");

        assertEquals(2, line.spans().getFirst().style().widthMult());
        assertEquals(3, line.spans().getFirst().style().heightMult());
    }

    @Test
    void parsesSingleSizeArgumentAsBothMultipliers() throws Exception {
        Line line = MarkupParser.parse("<size=2>BIG</size>");

        assertEquals(2, line.spans().getFirst().style().widthMult());
        assertEquals(2, line.spans().getFirst().style().heightMult());
    }

    @Test
    void parsesUnderlineThickness() throws Exception {
        assertEquals(2, MarkupParser.parse("<underline=2>x</underline>")
                .spans().getFirst().style().underline());
    }

    @Test
    void parsesFontSelection() throws Exception {
        assertEquals(Font.B, MarkupParser.parse("<font=b>x</font>")
                .spans().getFirst().style().font());
    }

    @Test
    void tagNamesAreCaseInsensitive() throws Exception {
        assertTrue(MarkupParser.parse("<BOLD>x</BOLD>").spans().getFirst().style().bold());
    }

    // -------------------------------------------------------------------------
    // Alignment
    // -------------------------------------------------------------------------

    @Test
    void alignmentBecomesALinePropertyRatherThanASpanStyle() throws Exception {
        Line line = MarkupParser.parse("<align=center>RECEIPT</align>");

        assertEquals(Align.CENTER, line.align());
        assertEquals("RECEIPT", line.plainText());
    }

    @Test
    void rejectsAlignmentThatDoesNotEncloseTheWholeLine() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<align=center>x</align> trailing"));

        assertEquals(MarkupError.INVALID_ALIGN_SCOPE, thrown.error());
    }

    @Test
    void rejectsASecondAlignmentTag() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<align=left><align=right>x</align></align>"));

        assertEquals(MarkupError.INVALID_ALIGN_SCOPE, thrown.error());
    }

    // -------------------------------------------------------------------------
    // Directives
    // -------------------------------------------------------------------------

    @Test
    void parsesCutAsADirectiveOnlyLine() throws Exception {
        Line line = MarkupParser.parse("<cut>");

        assertTrue(line.isDirectiveOnly());
        assertEquals(List.of(new Directive.Cut(Directive.Cut.Mode.FULL)), line.directives());
    }

    @Test
    void parsesPartialCut() throws Exception {
        assertEquals(List.of(new Directive.Cut(Directive.Cut.Mode.PARTIAL)),
                MarkupParser.parse("<cut=partial>").directives());
    }

    @Test
    void parsesFeedWithLineCount() throws Exception {
        assertEquals(List.of(new Directive.Feed(3)), MarkupParser.parse("<feed=3>").directives());
    }

    @Test
    void parsesRuleAloneOnItsLine() throws Exception {
        assertEquals(List.of(new Directive.Rule()), MarkupParser.parse("<hr>").directives());
    }

    @Test
    void rejectsRuleSharingALineWithText() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("Total <hr>"));

        assertEquals(MarkupError.INVALID_RULE_SCOPE, thrown.error());
    }

    @Test
    void voidTagsCannotBeClosed() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<cut></cut>"));

        assertEquals(MarkupError.UNEXPECTED_CLOSE_TAG, thrown.error());
    }

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    @Test
    void rejectsUnknownTagAtItsOwnColumn() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("ab <blink>x</blink>"));

        assertEquals(MarkupError.UNKNOWN_TAG, thrown.error());
        assertEquals(4, thrown.column());
        assertEquals("blink", thrown.detail());
    }

    @Test
    void rejectsUnclosedTagAtTheOpeningColumn() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("Total: <bold>12.30"));

        assertEquals(MarkupError.UNCLOSED_TAG, thrown.error());
        assertEquals(8, thrown.column());
        assertEquals("bold", thrown.detail());
    }

    @Test
    void rejectsClosingTagWithNoMatchingOpen() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("x</bold>"));

        assertEquals(MarkupError.UNEXPECTED_CLOSE_TAG, thrown.error());
        assertEquals(2, thrown.column());
    }

    @Test
    void rejectsOverlappingTags() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<bold><underline>x</bold></underline>"));

        assertEquals(MarkupError.UNEXPECTED_CLOSE_TAG, thrown.error());
    }

    @Test
    void rejectsSizeMultiplierAboveEight() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<size=9,1>x</size>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    @Test
    void rejectsNonNumericSizeArgument() {
        assertEquals(MarkupError.INVALID_TAG_ARGUMENT,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("<size=big>x</size>")).error());
    }

    @Test
    void rejectsArgumentOnATagThatTakesNone() {
        assertEquals(MarkupError.INVALID_TAG_ARGUMENT,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("<bold=1>x</bold>")).error());
    }

    @Test
    void rejectsMissingArgumentOnATagThatRequiresOne() {
        assertEquals(MarkupError.INVALID_TAG_ARGUMENT,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("<align>x</align>")).error());
    }

    @Test
    void rejectsUnterminatedTag() {
        assertEquals(MarkupError.UNKNOWN_TAG,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("<bold x")).error());
    }

    /**
     * A raw ESC byte is what markup exists to replace. Letting one through would let a
     * caller desynchronise the printer, which is precisely what the grammar prevents.
     */
    @Test
    void rejectsControlCharactersAtTheirColumn() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse(ESCAPE_IN_TEXT));

        assertEquals(MarkupError.CONTROL_CHARACTER, thrown.error());
        assertEquals(3, thrown.column());
    }

    @Test
    void rejectsTabAsAControlCharacter() {
        assertEquals(MarkupError.CONTROL_CHARACTER,
                assertThrows(MarkupException.class, () -> MarkupParser.parse("a\tb")).error());
    }

    @Test
    void rejectsDeleteAndC1Controls() {
        assertEquals(MarkupError.CONTROL_CHARACTER,
                assertThrows(MarkupException.class, () -> MarkupParser.parse("a" + (char) 0x7F + "b")).error());
        assertEquals(MarkupError.CONTROL_CHARACTER,
                assertThrows(MarkupException.class, () -> MarkupParser.parse("a" + (char) 0x85 + "b")).error());
    }

    @Test
    void leavesWrapUnsetWhenNoTagIsPresent() throws Exception {
        assertNull(MarkupParser.parse("Yhteensa 14.80").wrap());
    }

    @Test
    void readsNowrapAsARefusalToWrap() throws Exception {
        assertEquals(Boolean.FALSE, MarkupParser.parse("<nowrap>Yhteensa</nowrap>").wrap());
    }

    @Test
    void readsWrapAsARequestToWrap() throws Exception {
        assertEquals(Boolean.TRUE, MarkupParser.parse("<wrap>Iso kahvi</wrap>").wrap());
    }

    @Test
    void nestsWithAlignmentInEitherOrder() throws Exception {
        Line inner = MarkupParser.parse("<align=right><nowrap>x</nowrap></align>");
        Line outer = MarkupParser.parse("<nowrap><align=right>x</align></nowrap>");

        assertEquals(Align.RIGHT, inner.align());
        assertEquals(Boolean.FALSE, inner.wrap());
        assertEquals(Align.RIGHT, outer.align());
        assertEquals(Boolean.FALSE, outer.wrap());
    }

    @Test
    void refusesTextAroundAWrapTag() {
        assertEquals(MarkupError.INVALID_WRAP_SCOPE,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("Total: <nowrap>14.80</nowrap>")).error());
        assertEquals(MarkupError.INVALID_WRAP_SCOPE,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("<nowrap>14.80</nowrap> paid")).error());
    }

    @Test
    void refusesALineThatBothWrapsAndDoesNot() {
        assertEquals(MarkupError.INVALID_WRAP_SCOPE,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("<wrap><nowrap>x</nowrap></wrap>")).error());
    }

    @Test
    void refusesAWrapTagInsideAStylingTag() {
        assertEquals(MarkupError.INVALID_WRAP_SCOPE,
                assertThrows(MarkupException.class,
                        () -> MarkupParser.parse("<bold><nowrap>x</nowrap></bold>")).error());
    }
}
