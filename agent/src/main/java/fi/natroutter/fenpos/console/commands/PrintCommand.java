package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintRequestException;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.print.QueueRejectedException;

import java.util.Arrays;

/**
 * Prints one line through the complete pipeline, markup included.
 * <p>
 * Deliberately compiles and queues rather than writing to the port directly, so it exercises
 * the same path a dispatched job takes — including markup errors and codepage rejections.
 */
public class PrintCommand extends DeviceCommand {

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public PrintCommand(ConsoleOutput out, PrintService printing) {
        super(out, printing);
    }

    @Override
    public String name() {
        return "print";
    }

    @Override
    public String description() {
        return "Print one line of text, markup allowed";
    }

    @Override
    public String usage() {
        return "print <device> <text...>";
    }

    @Override
    public void execute(String[] args) {
        if (args.length < 2) {
            out.println("Usage: " + usage());
            return;
        }
        resolveDevice(args).ifPresent(device ->
                submit(device, String.join(" ", Arrays.copyOfRange(args, 1, args.length))));
    }

    private void submit(Device device, String text) {
        String body = "{\"data\":[" + PrintPayloads.jsonString(text) + "]}";
        try {
            PrintJob job = printing.submit(device, body);
            out.println("Queued " + job.id() + " on " + device.name() + ".");
        } catch (PrintRequestException e) {
            out.println("Rejected (" + e.apiCode() + "): " + e.getMessage());
        } catch (QueueRejectedException e) {
            out.println("Rejected (" + e.apiCode() + "): " + e.getMessage());
        }
    }
}
