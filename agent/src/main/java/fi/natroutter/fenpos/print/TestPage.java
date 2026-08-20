package fi.natroutter.fenpos.print;

import com.google.gson.Gson;
import fi.natroutter.fenpos.device.Device;

import java.util.ArrayList;
import java.util.List;

/**
 * A page that exercises a printer's configuration.
 * <p>
 * Answers the questions that actually come up when a printer misbehaves: is the paper width
 * right, does the codepage carry the characters this site needs, and do the style commands take
 * effect. The column ruler makes a wrong {@code columns} setting visible at a glance rather than
 * requiring someone to count characters.
 * <p>
 * Composed on the agent rather than the server, and deliberately so: a test page exists to prove
 * what the printer does with the settings this agent holds. Compiling it from the server's copy
 * of those settings would test the wrong thing — it would still pass if the two had diverged,
 * which is exactly the fault someone reaches for a test page to find.
 * <p>
 * <b>There is no {@code <drawer>} here, and there is no way to add one.</b> The tag does not exist
 * in the markup this agent parses. A test page that popped the till every time someone checked a
 * printer's alignment would be an unpleasant surprise, and the surest way not to write one is for
 * the grammar not to have the word.
 */
public final class TestPage {

    private static final Gson GSON = new Gson();

    /** Characters worth checking, of which only the representable ones are printed. */
    private static final String CANDIDATES =
            "ABC abc 123 .,:;!? #%&*()[] +-=/ ÄÖÅäöå éèü ñ ç £ € §";

    /** Payload for the barcode. Code 39's alphabet is digits, uppercase, space and {@code -.$/+%}. */
    private static final String BARCODE_CONTENT = "FENPOS";

    /** Payload for the QR code: short enough to stay a low version at the default module size. */
    private static final String QR_CONTENT = "https://fenpos.test/page";

    /** Payload for the PDF417 symbol. */
    private static final String PDF417_CONTENT = "FENPOS TEST";

    private TestPage() {
    }

    /**
     * Builds the request body for a device's test page.
     *
     * @param device the printer to describe and print on
     * @return a body the compile pipeline accepts
     */
    public static String bodyFor(Device device) {
        int columns = device.print().columns();
        List<String> lines = new ArrayList<>();

        lines.add("<align=center><bold>FenPOS test page</bold></align>");
        lines.add("<hr>");
        lines.add("Device:   " + device.name());
        lines.add("Columns:  " + columns);
        lines.add("Codepage: " + device.print().codepage().name());
        lines.add("<hr>");

        lines.add("Width ruler (should end exactly here):");
        lines.add(ruler(columns));

        lines.add("<hr>");
        lines.add("<bold>bold</bold> <underline>underline</underline> <invert>invert</invert>");
        lines.add("<size=2,2>Double</size>");
        lines.add("<align=left>left</align>");
        lines.add("<align=center>center</align>");
        lines.add("<align=right>right</align>");

        lines.add("<hr>");
        lines.add("Codepage sample:");
        lines.add(sampleFor(device));

        lines.add("<hr>");
        lines.add("Blocks:");
        lines.add("<align=center><qr>" + QR_CONTENT + "</qr></align>");
        lines.add("<align=center><barcode=CODE39>" + BARCODE_CONTENT + "</barcode></align>");
        lines.add("<align=center><pdf417>" + PDF417_CONTENT + "</pdf417></align>");

        lines.add("<feed=3>");
        lines.add("<cut>");

        return "{\"data\":" + GSON.toJson(lines) + "}";
    }

    /** Builds a ruler marking every tenth column, so miscounts are obvious on paper. */
    private static String ruler(int columns) {
        StringBuilder ruler = new StringBuilder(columns);
        for (int column = 1; column <= columns; column++) {
            if (column % 10 == 0) {
                ruler.append((column / 10) % 10);
            } else if (column % 5 == 0) {
                ruler.append('+');
            } else {
                ruler.append('.');
            }
        }
        return ruler.toString();
    }

    /**
     * Returns characters worth checking for the configured codepage.
     * <p>
     * Only characters the codepage can actually represent are included; anything else would make
     * the device's own {@code onUnsupported} policy reject the test page, which would say nothing
     * useful about the printer.
     */
    private static String sampleFor(Device device) {
        StringBuilder usable = new StringBuilder();
        var encoder = device.print().codepage().charset().newEncoder();
        CANDIDATES.codePoints().forEach(codePoint -> {
            String character = new String(Character.toChars(codePoint));
            if (encoder.canEncode(character)) {
                usable.append(character);
            }
        });
        return usable.toString();
    }
}
