package fi.natroutter.fenpos.markup;

import com.google.gson.Gson;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Runs the markup cases the panel's {@code test/lib/markup/parity.test.ts} runs, against this parser.
 * <p>
 * One list for both sides is what keeps the two parsers in step: a case cannot be added to one and
 * forgotten on the other. Where this agent deliberately differs — a tag or a font only the server can
 * draw, and {@code <drawer>} — a case carries this side's expectation as {@code agent}.
 */
class MarkupParityTest {

    record Refusal(String code, int line, int column, String detail, String message) {
    }

    record ParityCase(String name, String markup, Refusal refusal, Refusal agent) {

        Refusal expected() {
            return agent != null ? agent : refusal;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    static List<ParityCase> cases() throws IOException {
        try (InputStream stream = MarkupParityTest.class.getResourceAsStream("/markup/parity-cases.json")) {
            assertNotNull(stream, "parity-cases.json is on the test classpath");
            ParityCase[] cases = new Gson().fromJson(new InputStreamReader(stream, StandardCharsets.UTF_8),
                    ParityCase[].class);
            return List.of(cases);
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("cases")
    void refusesOrAcceptsAsTheServerDoes(ParityCase parity) {
        Refusal expected = parity.expected();
        if (expected == null) {
            assertDoesNotThrow(() -> MarkupParser.parseDocument(parity.markup()));
            return;
        }
        MarkupException thrown = assertThrows(MarkupException.class,
                () -> MarkupParser.parseDocument(parity.markup()));
        assertEquals(expected, new Refusal(thrown.error().apiCode(), thrown.line(), thrown.column(),
                thrown.detail(), thrown.getMessage()));
    }

    /**
     * Every tag, and every attribute each tag declares, is written in at least one case.
     * <p>
     * The panel asserts how many cases there are, which catches one that was deleted. This catches one
     * that was never written: a tag or an attribute added to the language reaches both parsers with no
     * shared case exercising it, and the count stays whatever it was.
     */
    @Test
    void everyTagAndAttributeIsWrittenInACase() throws IOException {
        List<String> markups = cases().stream().map(ParityCase::markup).collect(Collectors.toList());
        String written = String.join("\n", markups).toLowerCase(Locale.ROOT);

        List<String> missing = new ArrayList<>();
        for (Tag tag : Tag.values()) {
            if (!written.contains("<" + tag.tagName())) {
                missing.add("<" + tag.tagName() + ">");
            }
            for (String attribute : tag.attributes().keySet()) {
                if (!writesAttributeOnItsOwnTag(markups, tag.tagName(), attribute)) {
                    missing.add("<" + tag.tagName() + "> " + attribute);
                }
            }
        }

        assertEquals(List.of(), missing, "tags and attributes no parity case writes");
    }

    /**
     * Whether some case writes {@code attribute=} inside an opening {@code <tagName ...>}, rather
     * than merely somewhere in the fixture under the same name.
     * <p>
     * Unscoped, {@code <barcode>}'s {@code type} would be satisfied by {@code <chart type=bar>}
     * and {@code <image>}'s {@code width} by {@code <size width=...>}: two different attributes
     * that happen to share a name. Each tag's own occurrence is searched instead, up to the
     * {@code >} that closes it, skipping one written inside a quoted value.
     */
    private static boolean writesAttributeOnItsOwnTag(List<String> markups, String tagName, String attribute) {
        Pattern openTag = Pattern.compile("(?i)<" + Pattern.quote(tagName) + "(?=[\\s>])");
        Pattern attributeWritten = Pattern.compile("(?i)(^|[^a-zA-Z0-9_-])" + Pattern.quote(attribute) + "=");

        for (String markup : markups) {
            Matcher tagMatch = openTag.matcher(markup);
            while (tagMatch.find()) {
                int i = tagMatch.end();
                boolean inQuotes = false;
                while (i < markup.length()) {
                    char c = markup.charAt(i);
                    if (c == '"') {
                        inQuotes = !inQuotes;
                    } else if (c == '>' && !inQuotes) {
                        break;
                    }
                    i++;
                }
                String header = markup.substring(tagMatch.end(), i);
                if (attributeWritten.matcher(header).find()) {
                    return true;
                }
            }
        }
        return false;
    }
}
