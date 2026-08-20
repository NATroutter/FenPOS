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
import fi.natroutter.fenpos.markup.model.Directive;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link TestPage}.
 * <p>
 * The page's whole purpose is that it prints. So the tests that matter are that it compiles on a
 * real device — including the block tags added for the symbols and the logo — and that it still
 * compiles on an agent that was never sent the logo, which is the ordinary state of a fresh
 * install.
 */
class TestPageTest {

    /** A one-dot image, standing in for a synced logo. */
    private static final Directive.Image LOGO_RASTER =
            new Directive.Image(1, 1, new byte[] {(byte) 0x80});

    /** Answers for the logo at the whole paper width, which is what a bare {@code <image>} asks. */
    private static final ImageResolver HOLDS_LOGO = (name, widthPercent) ->
            "fenpos-logo".equals(name) && widthPercent == 100
                    ? Optional.of(LOGO_RASTER)
                    : Optional.empty();

    @Test
    void compilesOnADeviceHoldingTheLogo() throws Exception {
        CompiledJob job = PrintCompiler.compile(
                TestPage.bodyFor(device(), HOLDS_LOGO), device(), HOLDS_LOGO);

        assertTrue(job.payload().length > 0);
    }

    /**
     * The case a fresh install is always in. The page must still compile, because a diagnostic
     * that fails for a reason having nothing to do with the printer is a worse diagnostic.
     */
    @Test
    void compilesOnADeviceThatWasNeverSentTheLogo() throws Exception {
        CompiledJob job = PrintCompiler.compile(
                TestPage.bodyFor(device(), ImageResolver.NONE), device(), ImageResolver.NONE);

        assertTrue(job.payload().length > 0);
    }

    @Test
    void printsTheLogoOnlyWhenTheAgentHoldsIt() {
        assertTrue(elements(HOLDS_LOGO).contains("<align=center><image>fenpos-logo</image></align>"));
        assertTrue(elements(ImageResolver.NONE).stream().noneMatch(line -> line.contains("<image")));
    }

    @Test
    void printsEachOfTheSymbolBlocks() {
        List<String> lines = elements(ImageResolver.NONE);

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
        assertTrue(elements(HOLDS_LOGO).stream().noneMatch(line -> line.contains("drawer")));
    }

    @Test
    void keepsTheRulerExactlyAsWideAsThePaper() {
        assertTrue(elements(ImageResolver.NONE).contains(
                        "....+....1....+....2....+....3.."),
                "a 32-column ruler should end two dots past the third ten");
    }

    @Test
    void namesTheDeviceAndItsSettings() {
        List<String> lines = elements(ImageResolver.NONE);

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
