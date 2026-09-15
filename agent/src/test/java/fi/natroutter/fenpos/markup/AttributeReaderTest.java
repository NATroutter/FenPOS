package fi.natroutter.fenpos.markup;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class AttributeReaderTest {

    private static final Map<String, AttributeSpec> TABLE = AttributeSpec.table(
            "width", AttributeSpec.integer(1, 100),
            "border", AttributeSpec.oneOf("single", "double", "thick", "none"),
            "title", AttributeSpec.text(64),
            "lines", AttributeSpec.markRequired(AttributeSpec.integer(1, 255)),
            "char", AttributeSpec.character());

    private static RawAttribute attribute(String name, String value, int column) {
        return new RawAttribute(name, value, column);
    }

    private static MarkupException refusal(RawAttribute... raw) {
        return assertThrows(MarkupException.class, () -> AttributeReader.read("box", List.of(raw), TABLE, 3, 5));
    }

    @Test
    void coercesIntegersAndReturnsEnumsInTheTablesSpelling() throws Exception {
        Attributes read = AttributeReader.read("box", List.of(
                attribute("width", "60", 6),
                attribute("border", "Double", 15),
                attribute("title", "Sales by hour", 29),
                attribute("lines", "3", 40)), TABLE, 1, 1);

        assertEquals(Map.of("width", 60, "border", "double", "title", "Sales by hour", "lines", 3), read.values());
        assertEquals(15, read.column("border"));
        assertEquals(60, read.integer("width", 1));
        assertEquals(7, read.integer("missing", 7));
    }

    @Test
    void refusesAnAttributeTheTableDoesNotDeclare() {
        MarkupException e = refusal(attribute("colour", "red", 6));

        assertEquals(MarkupError.UNKNOWN_ATTRIBUTE, e.error());
        assertEquals(3, e.line());
        assertEquals(6, e.column());
        assertEquals("colour", e.detail());
        assertEquals("<box> has no attribute 'colour'", e.getMessage());
    }

    @Test
    void refusesAnAttributeSetTwiceEvenWhenTheFirstWasEmpty() {
        MarkupException e = refusal(attribute("title", "", 6), attribute("title", "A", 15));

        assertEquals(MarkupError.INVALID_ATTRIBUTE, e.error());
        assertEquals(15, e.column());
        assertEquals("<box> sets 'title' twice", e.getMessage());
    }

    @Test
    void refusesAMissingRequiredAttributeAtTheTagsColumn() {
        MarkupException e = refusal();

        assertEquals(MarkupError.INVALID_ATTRIBUTE, e.error());
        assertEquals(5, e.column());
        assertEquals("lines", e.detail());
        assertEquals("<box> requires lines", e.getMessage());
    }

    @Test
    void treatsAnEmptyTextValueAsLeftOff() throws Exception {
        Attributes read = AttributeReader.read("box",
                List.of(attribute("title", "", 6), attribute("lines", "1", 15)), TABLE, 1, 1);

        assertEquals(Map.of("lines", 1), read.values());
    }

    @Test
    void refusesARequiredTextAttributeWrittenEmptyAsMissing() {
        Map<String, AttributeSpec> table = AttributeSpec.table("font", AttributeSpec.markRequired(AttributeSpec.text(64)));
        MarkupException e = assertThrows(MarkupException.class,
                () -> AttributeReader.read("text", List.of(attribute("font", "", 7)), table, 1, 1));

        assertEquals(MarkupError.INVALID_ATTRIBUTE, e.error());
        assertEquals(1, e.column());
        assertEquals("<text> requires font", e.getMessage());
    }

    @Test
    void acceptsOnlyAsciiWholeNumbers() {
        for (String value : List.of("+3", " 3", "٣", "3.0", "", "99999999999")) {
            MarkupException e = refusal(attribute("width", value, 6));

            assertEquals(MarkupError.INVALID_ATTRIBUTE, e.error(), value);
            assertEquals(6, e.column(), value);
            assertEquals("<box> width=" + value + " is not accepted; expected a whole number from 1 to 100",
                    e.getMessage(), value);
        }
    }

    @Test
    void refusesAWholeNumberOutsideItsRange() {
        assertEquals("<box> width=0 is not accepted; expected a whole number from 1 to 100",
                refusal(attribute("width", "0", 6)).getMessage());
        assertEquals("<box> width=101 is not accepted; expected a whole number from 1 to 100",
                refusal(attribute("width", "101", 6)).getMessage());
    }

    @Test
    void listsAnEnumsValuesInTheTablesSpelling() {
        assertEquals("<box> border=wavy is not accepted; expected single, double, thick or none",
                refusal(attribute("border", "wavy", 6)).getMessage());
    }

    @Test
    void refusesTextLongerThanItsLimit() {
        String title = "x".repeat(65);

        assertEquals("<box> title=" + title + " is not accepted; expected at most 64 characters",
                refusal(attribute("title", title, 6)).getMessage());
    }

    @Test
    void takesExactlyOneCharacterCountedInCodePoints() throws Exception {
        Attributes read = AttributeReader.read("box",
                List.of(attribute("char", "😀", 6), attribute("lines", "1", 15)), TABLE, 1, 1);

        assertEquals("😀", read.string("char"));
        assertEquals("<box> char=ab is not accepted; expected a single character",
                refusal(attribute("char", "ab", 6)).getMessage());
        assertEquals("<box> char= is not accepted; expected a single character",
                refusal(attribute("char", "", 6)).getMessage());
    }
}
