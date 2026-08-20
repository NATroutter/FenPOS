package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintRequestException;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.print.QueueRejectedException;
import fi.natroutter.fenpos.print.SyncedImages;
import fi.natroutter.fenpos.print.TestPage;

/**
 * Prints a page that exercises the device's configuration.
 * <p>
 * The page itself lives in {@link TestPage}, because the panel can ask for the same thing over
 * the link and the two must produce identical paper — a test page that differed depending on who
 * asked for it would be useless for comparing one against the other.
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

    private void printTestPage(Device device) {
        try {
            PrintJob job = printing.submit(device,
                    TestPage.bodyFor(device, SyncedImages.forDevice(device, printing.devices())));
            out.println("Queued test page " + job.id() + " on " + device.name() + ".");
        } catch (PrintRequestException e) {
            out.println("Test page rejected (" + e.apiCode() + "): " + e.getMessage());
        } catch (QueueRejectedException e) {
            out.println("Test page rejected (" + e.apiCode() + "): " + e.getMessage());
        }
    }
}
