package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintRequestException;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.print.QueueRejectedException;

import java.util.ArrayList;
import java.util.List;

/**
 * Prints a page that exercises the device's configuration.
 * <p>
 * Answers the questions that actually come up when a printer misbehaves: is the paper width
 * right, does the codepage carry the characters this site needs, and do the style commands
 * take effect. The column ruler makes a wrong {@code columns} setting visible at a glance
 * rather than requiring someone to count characters.
 */
public class TestCommand extends DeviceCommand {

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public TestCommand(ConsoleOutput out, PrintService printing) {
        super(out, printing);
    }

    @Override
    public String name() {
        return "test";
    }

    @Override
    public String description() {
        return "Print a page exercising width, styles and codepage";
    }

    @Override
    public String usage() {
        return "test <device>";
    }

    @Override
    public void execute(String[] args) {
        resolveDevice(args).ifPresent(this::printTestPage);
    }

    private void printTestPage(DeviceSettings device) {
        int columns = device.print().columns();
        List<String> lines = new ArrayList<>();

        lines.add("<align=center><bold>ThermAPI test page</bold></align>");
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

        lines.add("<feed=3>");
        lines.add("<cut>");

        try {
            PrintJob job = printing.submit(device, PrintPayloads.body(lines));
            out.println("Queued test page " + job.id() + " on " + device.name() + ".");
        } catch (PrintRequestException e) {
            out.println("Test page rejected (" + e.apiCode() + "): " + e.getMessage());
        } catch (QueueRejectedException e) {
            out.println("Test page rejected (" + e.apiCode() + "): " + e.getMessage());
        }
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
     * Only characters the codepage can actually represent are included; anything else would
     * make the device's own {@code onUnsupported} policy reject the test page, which would
     * say nothing useful about the printer.
     */
    private static String sampleFor(DeviceSettings device) {
        String candidates = "ABC abc 123 .,:;!? #%&*()[] +-=/ ÄÖÅäöå éèü ñ ç £ € §";
        StringBuilder usable = new StringBuilder();
        var encoder = device.print().codepage().charset().newEncoder();
        candidates.codePoints().forEach(codePoint -> {
            String character = new String(Character.toChars(codePoint));
            if (encoder.canEncode(character)) {
                usable.append(character);
            }
        });
        return usable.toString();
    }
}
