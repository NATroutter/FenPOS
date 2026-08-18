package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintService;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Withdraws a job that has not started printing.
 * <p>
 * Completes only for a queued job: once bytes are going down the wire the paper is already
 * moving, and reporting success would be a lie.
 */
public class CancelCommand implements Command {

    private final ConsoleOutput out;
    private final PrintService printing;

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public CancelCommand(ConsoleOutput out, PrintService printing) {
        this.out = Objects.requireNonNull(out, "out");
        this.printing = Objects.requireNonNull(printing, "printing");
    }

    @Override
    public String name() {
        return "cancel";
    }

    @Override
    public String description() {
        return "Cancel a queued job";
    }

    @Override
    public String usage() {
        return "cancel <id>";
    }

    @Override
    public List<String> complete(String[] args) {
        if (args.length > 0) {
            return List.of();
        }
        return printing.jobs().all().stream()
                .filter(job -> !job.isTerminal())
                .map(PrintJob::id)
                .toList();
    }

    @Override
    public void execute(String[] args) {
        if (args.length == 0) {
            out.println("Usage: " + usage());
            return;
        }

        Optional<PrintJob> found = printing.jobs().find(args[0]);
        if (found.isEmpty()) {
            out.println("No job '" + args[0] + "'.");
            return;
        }

        PrintJob job = found.get();
        if (job.cancel()) {
            out.println("Cancelled " + job.id() + ".");
        } else {
            out.println("Cannot cancel " + job.id() + "; it is already "
                    + job.state().name().toLowerCase() + ".");
        }
    }
}
