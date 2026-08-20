package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
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

    /**
     * Deliberate, not incidental: the line-owning rule that governs {@code <wrap>}/{@code <nowrap>}
     * also governs {@code <align>}, so a line-owning tag opened inside a styling tag is refused
     * regardless of which one it is. See "Changes by component" in the wrap-tags design spec.
     */
    @Test
    void rejectsAlignmentOpenedInsideAStylingTagSameAsWrap() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<bold><align=right>x</align></bold>"));

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

    @Test
    void enclosesStylingTags() throws Exception {
        Line line = MarkupParser.parse("<nowrap><bold>Yhteensa 14.80</bold></nowrap>");

        assertEquals(Boolean.FALSE, line.wrap());
        assertTrue(line.spans().getFirst().style().bold());
    }

    @Test
    void permitsARuleWhereWrappingIsANoOp() throws Exception {
        Line line = MarkupParser.parse("<nowrap><hr></nowrap>");

        assertEquals(Boolean.FALSE, line.wrap());
        assertEquals(List.of(new Directive.Rule()), line.directives());
    }

    @Test
    void refusesNowrapClosingAnOpenWrap() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<wrap>x</nowrap>"));

        assertEquals(MarkupError.UNEXPECTED_CLOSE_TAG, thrown.error());
    }

    @Test
    void reportsTheColumnOfTheOffendingWrapTag() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("Total: <nowrap>14.80</nowrap>"));

        assertEquals(MarkupError.INVALID_WRAP_SCOPE, thrown.error());
        assertEquals(8, thrown.column());
    }

    // -------------------------------------------------------------------------
    // Blocks
    // -------------------------------------------------------------------------

    @Test
    void parsesQrWithTheDefaultModuleSize() throws Exception {
        Line line = MarkupParser.parse("<qr>https://fenpos.test/x</qr>");

        assertTrue(line.isDirectiveOnly());
        assertEquals(List.of(new Directive.Qr("https://fenpos.test/x", 6)), line.directives());
    }

    @Test
    void parsesQrModuleSizeArgument() throws Exception {
        assertEquals(List.of(new Directive.Qr("x", 12)),
                MarkupParser.parse("<qr=12>x</qr>").directives());
    }

    @Test
    void rejectsQrModuleSizeAboveSixteen() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<qr=17>x</qr>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
        assertEquals(1, thrown.column());
    }

    @Test
    void parsesBarcodeSymbology() throws Exception {
        assertEquals(List.of(new Directive.Barcode(BarcodeSystem.CODE39, "FENPOS")),
                MarkupParser.parse("<barcode=code39>FENPOS</barcode>").directives());
    }

    @Test
    void acceptsEverySymbologyThePanelOffers() throws Exception {
        for (BarcodeSystem system : BarcodeSystem.values()) {
            Line line = MarkupParser.parse(
                    "<barcode=" + system.name().toLowerCase() + ">12345670</barcode>");

            assertEquals(List.of(new Directive.Barcode(system, "12345670")), line.directives(),
                    "symbology " + system);
        }
    }

    @Test
    void rejectsUnknownBarcodeSymbology() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<barcode=qrcode>x</barcode>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    @Test
    void rejectsBarcodeWithoutASymbology() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<barcode>x</barcode>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    @Test
    void parsesPdf417WithTheDefaultErrorLevel() throws Exception {
        List<Directive> directives = MarkupParser.parse("<pdf417>FENPOS</pdf417>").directives();

        assertEquals(1, directives.size());
        Directive.Pdf417 symbol = (Directive.Pdf417) directives.getFirst();
        assertEquals("FENPOS", symbol.content());
        assertEquals(1, symbol.errorLevel());
    }

    @Test
    void parsesPdf417ErrorLevelArgument() throws Exception {
        Directive.Pdf417 symbol =
                (Directive.Pdf417) MarkupParser.parse("<pdf417=5>x</pdf417>").directives().getFirst();

        assertEquals(5, symbol.errorLevel());
    }

    /**
     * The agent has no PDF417 encoder, so it cannot measure the layout one would choose. It states
     * a fixed column count instead, which must be one the record accepts and one that fits the
     * narrowest paper: a row of {@code n} data columns is {@code 17 * (n + 4) + 1} modules across
     * at three dots each, and 58mm paper is 384 dots.
     */
    @Test
    void pdf417StatesAColumnCountThatFitsTheNarrowestPaper() throws Exception {
        Directive.Pdf417 symbol =
                (Directive.Pdf417) MarkupParser.parse("<pdf417>x</pdf417>").directives().getFirst();

        int widthDots = (17 * (symbol.columns() + 4) + 1) * 3;
        assertTrue(widthDots <= 384,
                "a PDF417 of " + symbol.columns() + " columns is " + widthDots + " dots wide");
    }

    @Test
    void rejectsPdf417ErrorLevelAboveEight() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<pdf417=9>x</pdf417>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    @Test
    void acceptsPdf417ErrorLevelZeroWhichIsNotAMissingArgument() throws Exception {
        Directive.Pdf417 symbol =
                (Directive.Pdf417) MarkupParser.parse("<pdf417=0>x</pdf417>").directives().getFirst();

        assertEquals(0, symbol.errorLevel());
    }

    @Test
    void capturesBlockContentAsDataRatherThanSpans() throws Exception {
        Line line = MarkupParser.parse("<qr>a b c</qr>");

        assertTrue(line.spans().isEmpty());
        assertEquals("a b c", ((Directive.Qr) line.directives().getFirst()).content());
    }

    @Test
    void decodesEntitiesInsideABlockIntoItsPayload() throws Exception {
        Line line = MarkupParser.parse("<qr>a&amp;b&lt;c</qr>");

        assertEquals("a&b<c", ((Directive.Qr) line.directives().getFirst()).content());
    }

    @Test
    void rejectsMarkupInsideABlock() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<qr>a<bold>b</bold></qr>"));

        assertEquals(MarkupError.INVALID_BLOCK_SCOPE, thrown.error());
        assertEquals(6, thrown.column());
    }

    @Test
    void rejectsAnEmptyBlock() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<qr></qr>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    /**
     * The renderer declares a symbol's length in characters and writes it as UTF-8, so a payload
     * outside ASCII would print as a symbol that scans wrongly.
     */
    @Test
    void rejectsNonAsciiSymbolContent() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<qr>Kahvilä</qr>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    @Test
    void rejectsBlockSharingItsElementWithText() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("Scan: <qr>x</qr>"));

        assertEquals(MarkupError.INVALID_BLOCK_SCOPE, thrown.error());
        assertEquals(7, thrown.column());
    }

    @Test
    void rejectsTwoBlocksInOneElement() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<qr>x</qr><qr>y</qr>"));

        assertEquals(MarkupError.INVALID_BLOCK_SCOPE, thrown.error());
        assertEquals(1, thrown.column());
    }

    @Test
    void rejectsABlockSharingItsElementWithARule() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<hr><qr>x</qr>"));

        assertEquals(MarkupError.INVALID_RULE_SCOPE, thrown.error());
    }

    @Test
    void permitsAlignmentAroundABlock() throws Exception {
        Line line = MarkupParser.parse("<align=center><qr>x</qr></align>");

        assertEquals(Align.CENTER, line.align());
        assertEquals(List.of(new Directive.Qr("x", 6)), line.directives());
    }

    @Test
    void rejectsAnUnclosedBlock() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<qr>x"));

        assertEquals(MarkupError.UNCLOSED_TAG, thrown.error());
        assertEquals(1, thrown.column());
    }

    // -------------------------------------------------------------------------
    // Images
    // -------------------------------------------------------------------------

    /** A one-dot image, which is the smallest thing {@link Directive.Image} accepts. */
    private static final Directive.Image ONE_DOT = new Directive.Image(1, 1, new byte[] {(byte) 0x80});

    @Test
    void resolvesAnImageAgainstWhatTheAgentHolds() throws Exception {
        Line line = MarkupParser.parse("<image>logo</image>", holding("logo", 100));

        assertTrue(line.isDirectiveOnly());
        assertEquals(List.of(ONE_DOT), line.directives());
    }

    /** A bare {@code <image>} means the whole printable width, which is what gets looked up. */
    @Test
    void anImageWithNoArgumentAsksForTheWholePaperWidth() {
        assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<image>logo</image>", holding("logo", 50)));
    }

    @Test
    void passesTheWidthPercentageToTheResolver() throws Exception {
        assertEquals(List.of(ONE_DOT),
                MarkupParser.parse("<image=40>logo</image>", holding("logo", 40)).directives());
    }

    @Test
    void rejectsAnImageThisAgentDoesNotHold() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<image>missing</image>", holding("logo", 100)));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
        assertEquals(1, thrown.column());
    }

    @Test
    void rejectsAnImageWhenNoResolverWasSupplied() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<image>logo</image>"));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    @Test
    void rejectsAnImageWidthAboveTheWholePaper() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<image=101>logo</image>", holding("logo", 101)));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    @Test
    void rejectsAnImageNamingNothing() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<image></image>", holding("logo", 100)));

        assertEquals(MarkupError.INVALID_TAG_ARGUMENT, thrown.error());
    }

    /**
     * A resolver holding exactly one image at exactly one printed width.
     *
     * @param name         the only name it answers to
     * @param widthPercent the only width it answers for
     * @return a resolver returning {@link #ONE_DOT} for that pair and nothing else
     */
    private static ImageResolver holding(String name, int widthPercent) {
        return (requested, requestedPercent) ->
                name.equals(requested) && widthPercent == requestedPercent
                        ? java.util.Optional.of(ONE_DOT)
                        : java.util.Optional.empty();
    }

    /**
     * {@code <drawer>} exists in the panel's grammar and deliberately not in this one, so that
     * nothing printed from the console or from a test page can fire the till.
     */
    @Test
    void hasNoDrawerTag() {
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parse("<drawer>"));

        assertEquals(MarkupError.UNKNOWN_TAG, thrown.error());
    }
}
