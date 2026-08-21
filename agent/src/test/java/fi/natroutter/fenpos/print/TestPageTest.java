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
 * real device — including the block tags added for the symbols and the bundled logo — and that it
 * still compiles on a device whose paper width nothing was bundled for, which is the one case where
 * the logo cannot be printed at all.
 */
class TestPageTest {

    /** The logo line, exactly as the page writes it. */
    private static final String LOGO_LINE = "<align=center><image>fenpos</image></align>";

    @Test
    void compilesOnADevice() throws Exception {
        ImageResolver images = BundledImages.forDevice(device());

        CompiledJob job = PrintCompiler.compile(TestPage.bodyFor(device(), images), device(), images);

        assertTrue(job.payload().length > 0);
    }

    /**
     * The case a device on unbundled paper is always in. The page must still compile: a diagnostic
     * that fails for a reason having nothing to do with the printer is a worse diagnostic than one
     * that quietly prints one block fewer.
     */
    @Test
    void compilesWhenTheLogoCannotBeResolved() throws Exception {
        CompiledJob job = PrintCompiler.compile(
                TestPage.bodyFor(device(), ImageResolver.NONE), device(), ImageResolver.NONE);

        assertTrue(job.payload().length > 0);
    }

    /**
     * The two halves of the conditional, stated as behaviour.
     * <p>
     * Both matter and for different reasons. Printing it proves the logo did not quietly stop being
     * part of the page; omitting it proves the guard is doing something, and this half fails the
     * moment the line is added unconditionally.
     */
    @Test
    void printsTheLogoOnlyWhenItResolves() {
        assertTrue(elements(BundledImages.forDevice(device())).contains(LOGO_LINE),
                "a 32-column device has a bundled logo and should print it");
        assertTrue(elements(ImageResolver.NONE).stream().noneMatch(line -> line.contains("<image")),
                "nothing resolves, so no <image> tag should be written");
    }

    @Test
    void printsEachOfTheSymbolBlocks() {
        List<String> lines = elements();

        assertTrue(lines.contains("<align=center><qr>https://natroutter.fi</qr></align>"),
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
        return elements(ImageResolver.NONE);
    }

    private static List<String> elements(ImageResolver images) {
        JsonArray data = JsonParser.parseString(TestPage.bodyFor(device(), images))
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
