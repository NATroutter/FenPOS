package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;

/** Resumes a paused device. */
public class ResumeCommand extends DeviceCommand {

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public ResumeCommand(ConsoleOutput out, PrintService printing) {
        super(out, printing);
    }

    @Override
    public String name() {
        return "resume";
    }

    @Override
    public String description() {
        return "Resume a paused device";
    }

    @Override
    public String usage() {
        return "resume <device>";
    }

    @Override
    public void execute(String[] args) {
        resolveDevice(args).ifPresent(device -> {
            printing.queue(device.name()).resume();
            out.println(device.name() + " resumed; "
                    + printing.queue(device.name()).depth() + " job(s) will now print.");
        });
    }
}
