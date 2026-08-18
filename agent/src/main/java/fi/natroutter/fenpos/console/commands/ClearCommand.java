package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;

/** Cancels everything waiting for a device, typically after clearing a jam. */
public class ClearCommand extends DeviceCommand {

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public ClearCommand(ConsoleOutput out, PrintService printing) {
        super(out, printing);
    }

    @Override
    public String name() {
        return "clear";
    }

    @Override
    public String description() {
        return "Cancel every queued job for a device";
    }

    @Override
    public String usage() {
        return "clear <device>";
    }

    @Override
    public void execute(String[] args) {
        resolveDevice(args).ifPresent(device -> {
            int cancelled = printing.queue(device.name()).clear();
            out.println("Cancelled " + cancelled + " queued job(s) for " + device.name() + ".");
        });
    }
}
