package fi.natroutter.fenpos.print;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.LimitSettings;
import fi.natroutter.fenpos.device.PrintSettings;
import fi.natroutter.fenpos.device.SerialSettings;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.markup.ImageResolver;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link TestPage}.
 * <p>
 * The page's whole purpose is that it prints. So the tests that matter are that it compiles on a
 * real device — including the block tags added for the symbols — and that its content answers the
 * questions a test page exists to answer.
 */
class TestPageTest {

    @Test
    void compilesOnADevice() throws Exception {
        CompiledJob job = PrintCompiler.compile(
                TestPage.bodyFor(device()), device(), ImageResolver.NONE);

        assertTrue(job.payload().length > 0);
    }

    @Test
    void printsEachOfTheSymbolBlocks() {
        List<String> lines = elements();

        assertTrue(lines.contains("<align=center><qr>https://fenpos.test/page</qr></align>"),
                "no QR code");
        assertTrue(lines.contains("<align=center><barcode=CODE39>FENPOS</barcode></align>"),
                "no barcode");
        assertTrue(lines.contains("<align=center><pdf417>FENPOS TEST</pdf417></align>"),
                "no PDF417 symbol");
    }

    /**
     * A diagnostic print must not pop the cash drawer. The tag does not exist in the markup this
     * agent parses, so a page containing one would not compile — but the page must not contain one
     * either, and this is the cheap check that says so.
     */
    @Test
    void neverOpensTheCashDrawer() {
        assertTrue(elements().stream().noneMatch(line -> line.contains("drawer")));
    }

    @Test
    void keepsTheRulerExactlyAsWideAsThePaper() {
        assertTrue(elements().contains(
                        "....+....1....+....2....+....3.."),
                "a 32-column ruler should end two dots past the third ten");
    }

    @Test
    void namesTheDeviceAndItsSettings() {
        List<String> lines = elements();

        assertTrue(lines.contains("Device:   kitchen"));
        assertTrue(lines.contains("Codepage: CP858"));
        assertTrue(lines.contains("Columns:  32"));
    }

    /**
     * The page's elements, as the compile pipeline will see them.
     * <p>
     * Read back out of the JSON rather than searched for in it: Gson escapes {@code <} and
     * {@code =}, so a substring check against the body would be a check on Gson's escaping rather
     * than on the markup.
     */
    private static List<String> elements() {
        JsonArray data = JsonParser.parseString(TestPage.bodyFor(device()))
                .getAsJsonObject()
                .getAsJsonArray("data");
        return data.asList().stream().map(JsonElement::getAsString).toList();
    }

    /** A 58mm printer: the narrowest paper, and so the tightest fit for the symbols. */
    private static Device device() {
        return new Device(
                "kitchen",
                new SerialSettings("COM3", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                        true, true, Duration.ofSeconds(5), Duration.ofMillis(5000)),
                new PrintSettings(32, Codepage.CP858, UnsupportedPolicy.REJECT, true, Linefeed.LF),
                new LimitSettings(100, 200, 4000, 200, 100),
                false);
    }
}
