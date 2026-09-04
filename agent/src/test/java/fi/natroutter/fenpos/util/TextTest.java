package fi.natroutter.fenpos.util;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * What happens to text this agent did not choose before it reaches a log file or a terminal.
 *
 * <p>Two things are being defended. A newline would forge a log line, because the logger
 * prefixes each one with a colour and nothing else marks where an entry begins. A brace would
 * forge a colour: {@code TermColor.parse} substitutes {@code {RED}} and thirty-two others
 * anywhere in a message, so a device description containing one drives real escapes at an
 * operator's terminal.
 */
class TextTest {

    @Test
    void rendersControlCharactersAsTheirCodePoints() {
        assertEquals("a\\u000Ab", Text.safe("a\nb"));
        assertEquals("a\\u001Bb", Text.safe("a\u001Bb"));
        assertEquals("a\\u0000b", Text.safe("a\u0000b"));
        assertEquals("a\\u007Fb", Text.safe("a\u007Fb"));
        assertEquals("a\\u009Bb", Text.safe("a\u009Bb"));
    }

    @Test
    void escapesABraceSoAColourTokenCannotBeForged() {
        assertEquals("\\u007BRED}", Text.safe("{RED}"));
        assertEquals("2 \\u007B 3", Text.safe("2 { 3"));
    }

    @Test
    void leavesNoColourTokenForASubstringReplaceToFind() {
        for (String token : List.of("{RED}", "{GREEN}", "{RESET}", "a {YELLOW} b")) {
            assertFalse(Text.safe(token).contains("{"), token);
        }
    }

    @Test
    void leavesOrdinaryTextAlone() {
        assertEquals("USB Serial (ch340)", Text.safe("USB Serial (ch340)"));
        assertEquals("Ravintola Kahvila", Text.safe("Ravintola Kahvila"));
        assertEquals("Ravintola Kahvilä, Töölö", Text.safe("Ravintola Kahvilä, Töölö"));
    }

    @Test
    void treatsNullAsEmpty() {
        assertEquals("", Text.safe(null));
    }
}
