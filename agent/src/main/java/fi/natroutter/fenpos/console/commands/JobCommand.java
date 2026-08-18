package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintService;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/** Shows everything known about one job, including why it failed. */
public class JobCommand implements Command {

    private final ConsoleOutput out;
    private final PrintService printing;

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public JobCommand(ConsoleOutput out, PrintService printing) {
        this.out = Objects.requireNonNull(out, "out");
        this.printing = Objects.requireNonNull(printing, "printing");
    }

    @Override
    public String name() {
        return "job";
    }

    @Override
    public String description() {
        return "Show detail for one job";
    }

    @Override
    public String usage() {
        return "job <id>";
    }

    @Override
    public List<String> complete(String[] args) {
        return args.length == 0
                ? printing.jobs().all().stream().map(PrintJob::id).toList()
                : List.of();
    }

    @Override
    public void execute(String[] args) {
        if (args.length == 0) {
            out.println("Usage: " + usage());
            return;
        }

        Optional<PrintJob> found = printing.jobs().find(args[0]);
        if (found.isEmpty()) {
            out.println("No job '" + args[0] + "'; it may have passed its retention window.");
            return;
        }

        PrintJob job = found.get();
        out.println("Job " + job.id());
        out.println("  Device:   " + job.deviceName());
        out.println("  State:    " + job.state());
        out.println("  Queued:   " + job.queuedAt());
        out.println("  Started:  " + orDash(job.startedAt()));
        out.println("  Finished: " + orDash(job.finishedAt()));
        out.println("  Size:     " + job.lines() + " lines, " + job.bytes() + " bytes");
        if (job.failureReason() != null) {
            out.println("  Failure:  " + job.failureReason());
        }
    }

    private static String orDash(Object value) {
        return value == null ? "-" : value.toString();
    }
}
