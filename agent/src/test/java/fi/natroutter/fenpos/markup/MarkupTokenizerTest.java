package fi.natroutter.fenpos.markup;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class MarkupTokenizerTest {

    private static MarkupException refusal(String source) {
        return assertThrows(MarkupException.class, () -> MarkupTokenizer.tokenize(source));
    }

    @Test
    void emitsOneTextTokenForAPlainLine() throws Exception {
        assertEquals(List.of(new MarkupToken.Text("Coffee 2.50", false, 1, 1)),
                MarkupTokenizer.tokenize("Coffee 2.50"));
    }

    @Test
    void splitsLinesOnNewlinesAndRestartsTheColumn() throws Exception {
        assertEquals(List.of(
                        new MarkupToken.Text("ab", false, 1, 1),
                        new MarkupToken.Break(1, 3),
                        new MarkupToken.Text("cd", false, 2, 1)),
                MarkupTokenizer.tokenize("ab\ncd"));
    }

    @Test
    void decodesEachEntityIntoATokenOfItsOwnAtItsColumn() throws Exception {
        assertEquals(List.of(
                        new MarkupToken.Text("a", false, 1, 1),
                        new MarkupToken.Text("\"", true, 1, 2),
                        new MarkupToken.Text("{", true, 1, 8),
                        new MarkupToken.Text("<", true, 1, 16),
                        new MarkupToken.Text("&", true, 1, 20)),
                MarkupTokenizer.tokenize("a&quot;&lbrace;&lt;&amp;"));
    }

    @Test
    void keepsAnAmpersandThatStartsNoEntity() throws Exception {
        assertEquals(List.of(new MarkupToken.Text("Fish & Chips", false, 1, 1)),
                MarkupTokenizer.tokenize("Fish & Chips"));
    }

    @Test
    void readsBareAndQuotedAttributesWithDecodedValuesAndKeyColumns() throws Exception {
        assertEquals(new MarkupToken.Open("x", List.of(
                        new RawAttribute("title", "He said \"hi\"", 4),
                        new RawAttribute("char", "&", 35),
                        new RawAttribute("other", "<", 46)), 1, 1),
                MarkupTokenizer.tokenize("<x title=\"He said &quot;hi&quot;\" char=&amp; other=&lt;>").getFirst());
    }

    @Test
    void keepsTheTagNameAsWrittenAndLowerCasesKeys() throws Exception {
        assertEquals(new MarkupToken.Open("SIZE", List.of(new RawAttribute("width", "2", 7)), 1, 1),
                MarkupTokenizer.tokenize("<SIZE WIDTH=2>").getFirst());
    }

    @Test
    void readsAClosingTag() throws Exception {
        assertEquals(List.of(new MarkupToken.Text("a", false, 1, 1), new MarkupToken.Close("bold", 1, 2)),
                MarkupTokenizer.tokenize("a</bold>"));
    }

    @Test
    void readsARawQuoteInsideABareValueAsPartOfIt() throws Exception {
        assertEquals(List.of(new RawAttribute("char", "a\"", 7)),
                ((MarkupToken.Open) MarkupTokenizer.tokenize("<fill char=a\">").getFirst()).attributes());
    }

    @Test
    void refusesAValueWrittenAgainstTheTagName() {
        MarkupException e = refusal("<align=center>");

        assertEquals(MarkupError.UNKNOWN_ATTRIBUTE, e.error());
        assertEquals(7, e.column());
        assertEquals("=", e.detail());
        assertEquals("<align> attributes are written key=value", e.getMessage());
    }

    @Test
    void refusesAQuotedValueWithNoClosingQuoteAsAnUnterminatedTag() {
        MarkupException e = refusal("<fill char=\">");

        assertEquals(MarkupError.UNKNOWN_TAG, e.error());
        assertEquals(1, e.column());
        assertEquals("<fill char=\">", e.detail());
        assertEquals("Unterminated tag; write &lt; for a literal '<'", e.getMessage());
    }

    @Test
    void refusesATagWhoseClosingBracketIsOnALaterLine() {
        MarkupException e = refusal("<bold\n>");

        assertEquals(MarkupError.UNKNOWN_TAG, e.error());
        assertEquals("<bold", e.detail());
    }

    @Test
    void refusesAControlCharacterInTextAtItsColumn() {
        MarkupException e = refusal("a");

        assertEquals(MarkupError.CONTROL_CHARACTER, e.error());
        assertEquals(2, e.column());
        assertEquals("U+0001", e.detail());
    }

    @Test
    void refusesAControlCharacterInAValueAtItsKey() {
        MarkupException e = refusal("<fill char=a>");

        assertEquals(MarkupError.CONTROL_CHARACTER, e.error());
        assertEquals(7, e.column());
        assertEquals("char", e.detail());
    }

    /**
     * DEL and the C1 range are commands to a printer as much as the C0 range is, and they sit at the
     * far end of the predicate. Built from char codes rather than string literals so the bytes stay
     * visible to anyone reading this file.
     */
    @Test
    void refusesDeleteAndC1ControlsAtTheirColumn() {
        MarkupException delete = refusal("a" + (char) 0x7F + "b");

        assertEquals(MarkupError.CONTROL_CHARACTER, delete.error());
        assertEquals(2, delete.column());
        assertEquals("U+007F", delete.detail());

        MarkupException c1 = refusal("a" + (char) 0x85 + "b");

        assertEquals(MarkupError.CONTROL_CHARACTER, c1.error());
        assertEquals(2, c1.column());
        assertEquals("U+0085", c1.detail());
    }

    @Test
    void refusesALaterSyntaxErrorBeforeAnythingIsParsed() {
        assertEquals(2, refusal("<feed lines=0>\n<bold x\">").line());
    }

    @Test
    void skipsIndentationBeforeATagAndKeepsItsColumn() throws Exception {
        assertEquals(new MarkupToken.Open("bold", List.of(), 1, 3), MarkupTokenizer.tokenize("  <bold>").getFirst());
        assertEquals(new MarkupToken.Open("bold", List.of(), 1, 2), MarkupTokenizer.tokenize("\t<bold>").getFirst());
    }

    @Test
    void skipsIndentationBeforeAClosingTagInsideAMultiLineBlock() throws Exception {
        assertEquals(List.of(
                        new MarkupToken.Open("qr", List.of(), 1, 1),
                        new MarkupToken.Text("abc", false, 1, 5),
                        new MarkupToken.Break(1, 8),
                        new MarkupToken.Close("qr", 2, 3)),
                MarkupTokenizer.tokenize("<qr>abc\n  </qr>"));
    }

    @Test
    void keepsIndentationBeforeText() throws Exception {
        assertEquals(List.of(new MarkupToken.Text("  - no onion", false, 1, 1)),
                MarkupTokenizer.tokenize("  - no onion"));
    }

    @Test
    void stillRefusesATabBeforeText() {
        assertEquals(MarkupError.CONTROL_CHARACTER, refusal("\tx").error());
    }

    @Test
    void decodesOnlyWholeEntitiesInAValue() {
        assertEquals("R&D \" & <", MarkupTokenizer.decodeEntities("R&D &quot; &amp; &lt;"));
        assertEquals("&lt", MarkupTokenizer.decodeEntities("&lt"));
        assertEquals("&lt;", MarkupTokenizer.decodeEntities("&amp;lt;"));
    }
}
