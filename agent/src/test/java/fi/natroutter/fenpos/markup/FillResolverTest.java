package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link FillResolver}.
 * <p>
 * The same table as {@code fill.test.ts}, with the same literal expectations. A literal is what
 * turns a divergence between the two implementations into a visible mismatch rather than two
 * implementations quietly agreeing on the same wrong arithmetic.
 */
class FillResolverTest {

    private static final int COLUMNS = 42;

    /** Parses, resolves, and flattens back to the characters that would print. */
    private static String filled(String source, int columns) throws Exception {
        return FillResolver.resolve(MarkupParser.parse(source), columns).plainText();
    }

    private static String filled(String source) throws Exception {
        return filled(source, COLUMNS);
    }

    @Test
    void padsATwoColumnRowToThePapersWidth() throws Exception {
        assertEquals("Coffee" + " ".repeat(32) + "2.50", filled("Coffee<fill>2.50"));
    }

    @Test
    void landsTheRowExactlyOnThePapersEdge() throws Exception {
        assertEquals(COLUMNS, FillResolver.resolve(MarkupParser.parse("Coffee<fill>2.50"), COLUMNS).columns());
    }

    @Test
    void repeatsTheCharacterTheTagNamed() throws Exception {
        assertEquals("Coffee" + ".".repeat(32) + "2.50", filled("Coffee<fill=.>2.50"));
    }

    @Test
    void splitsTheSlackEvenlyBetweenSeveralFills() throws Exception {
        assertEquals("Qty" + " ".repeat(15) + "Item" + " ".repeat(15) + "Price",
                filled("Qty<fill>Item<fill>Price"));
    }

    @Test
    void givesAnUnevenRemainderToTheEarliestGap() throws Exception {
        assertEquals("Qty" + " ".repeat(15) + "Items" + " ".repeat(14) + "Price",
                filled("Qty<fill>Items<fill>Price"));
    }

    @Test
    void stillLandsOnTheEdgeWhenTheRemainderIsUneven() throws Exception {
        assertEquals(COLUMNS,
                FillResolver.resolve(MarkupParser.parse("Qty<fill>Items<fill>Price"), COLUMNS).columns());
    }

    @Test
    void emitsNothingWhenTheTextAlreadyFillsThePaper() throws Exception {
        String text = "x".repeat(42);

        assertEquals(text, filled(text + "<fill>"));
    }

    /**
     * The label is 39 columns and the amount 5, so the row wants 44 of the paper's 42 — count them
     * before changing this string. An earlier draft used a 34-column label, which left three columns
     * of slack and so tested the opposite of what it names.
     */
    @Test
    void emitsNothingWhenTheTextOverrunsThePaper() throws Exception {
        assertEquals("A very long product name that goes here12.50",
                filled("A very long product name that goes here<fill>12.50"));
    }

    /**
     * The boundary the collapse rule does not reach: two columns of slack is still slack, and a
     * fill given it pads. Guards against a threshold creeping in below which padding is skipped — a
     * narrow roll is exactly where a jammed row is most likely and least noticed.
     */
    @Test
    void padsASingleFillGivenOnlyAFewColumnsOfSlack() throws Exception {
        assertEquals("Coffee  2.50", filled("Coffee<fill>2.50", 12));
    }

    /**
     * A budget that cannot buy even one character of an enlarged fill. Distinct from having no
     * slack: there are columns left over, and they stay unspent because the character will not fit.
     */
    @Test
    void emitsNothingWhenTheBudgetIsSmallerThanOneFillCharacter() throws Exception {
        Line line = FillResolver.resolve(MarkupParser.parse("X<size=2>A<fill>B</size>"), 6);

        assertEquals("XAB", line.plainText());
        assertEquals(5, line.columns());
    }

    /**
     * A fill inside {@code <size=2>} spends two columns per character, so an odd budget cannot be
     * spent exactly and the line lands a column short. Under the default multiplier it cannot arise.
     */
    @Test
    void spendsABudgetInWholeCharactersUnderAWidthMultiplier() throws Exception {
        Line line = FillResolver.resolve(MarkupParser.parse("X<size=2>A<fill>B</size>"), COLUMNS);

        assertEquals("XA" + " ".repeat(18) + "B", line.plainText());
        assertEquals(41, line.columns());
    }

    @Test
    void returnsALineWithNoFillsUntouched() throws Exception {
        Line line = MarkupParser.parse("Coffee 2.50");

        assertSame(line, FillResolver.resolve(line, COLUMNS));
    }

    @Test
    void emptiesTheFillsItResolved() throws Exception {
        assertTrue(FillResolver.resolve(MarkupParser.parse("a<fill>b"), COLUMNS).fills().isEmpty());
    }

    @Test
    void drawsARuleFromAFillThatIsAloneOnItsLine() throws Exception {
        assertEquals("-".repeat(42), filled("<fill=->"));
    }

    @Test
    void rightAlignsASegmentWhenTheFillLeads() throws Exception {
        assertEquals(" ".repeat(38) + "2.50", filled("<fill>2.50"));
    }

    @Test
    void padsToTheEdgeWhenTheFillTrails() throws Exception {
        assertEquals("Total" + " ".repeat(37), filled("Total<fill>"));
    }

    @Test
    void givesTheSingleColumnOfSlackToTheFirstFill() throws Exception {
        assertEquals("ab ", filled("ab<fill><fill><fill>", 3));
    }

    @Test
    void insertsThePadAsASpanOfItsOwnBetweenTheTwoItSeparates() throws Exception {
        Line line = FillResolver.resolve(MarkupParser.parse("a<fill>b"), COLUMNS);

        assertEquals(List.of("a", " ".repeat(40), "b"),
                line.spans().stream().map(Span::text).toList());
    }
}
