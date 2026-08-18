package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;

/**
 * Stops a device printing without discarding what is already queued.
 * <p>
 * New requests are refused with {@code 503} while paused, so a client learns immediately
 * rather than having work silently pile up behind a jam.
 */
public class PauseCommand extends DeviceCommand {

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public PauseCommand(ConsoleOutput out, PrintService printing) {
        super(out, printing);
    }

    @Override
    public String name() {
        return "pause";
    }

    @Override
    public String description() {
        return "Stop a device printing, keeping its queue";
    }

    @Override
    public String usage() {
        return "pause <device>";
    }

    @Override
    public void execute(String[] args) {
        resolveDevice(args).ifPresent(device -> {
            printing.queue(device.name()).pause();
            out.println(device.name() + " paused; "
                    + printing.queue(device.name()).depth() + " job(s) still queued. "
                    + "New requests will be refused until 'resume'.");
        });
    }
}
