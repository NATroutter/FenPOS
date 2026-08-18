package fi.natroutter.fenpos.encoding;

import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.markup.MarkupParser;
import fi.natroutter.fenpos.markup.model.Line;
import org.junit.jupiter.api.Test;

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
}
