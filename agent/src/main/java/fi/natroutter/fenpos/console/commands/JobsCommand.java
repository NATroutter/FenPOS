package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintService;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/** Lists recent jobs, optionally for one device. */
public class JobsCommand extends DeviceCommand {

    /** Rows shown by default, so a busy device does not flood the console. */
    private static final int DEFAULT_LIMIT = 20;

    /**
     * @param out      output sink
     * @param printing the print service
     */
    public JobsCommand(ConsoleOutput out, PrintService printing) {
        super(out, printing);
    }

    @Override
    public String name() {
        return "jobs";
    }

    @Override
    public String description() {
        return "List recent jobs, newest first";
    }

    @Override
    public String usage() {
        return "jobs [device]";
    }

    @Override
    public void execute(String[] args) {
        List<PrintJob> jobs;
        if (args.length == 0) {
            jobs = printing.jobs().all();
        } else {
            if (resolveDevice(args).isEmpty()) {
                return;
            }
            jobs = printing.jobs().forDevice(args[0]);
        }

        if (jobs.isEmpty()) {
            out.println("No jobs within the retention window.");
            return;
        }

        out.println(String.format("%-10s %-12s %-10s %6s %8s %s",
                "ID", "DEVICE", "STATE", "LINES", "BYTES", "AGE"));
        jobs.stream().limit(DEFAULT_LIMIT).forEach(job -> out.println(String.format(
                "%-10s %-12s %-10s %6d %8d %s",
                job.id(), job.deviceName(), job.state(), job.lines(), job.bytes(),
                age(job.queuedAt()))));

        if (jobs.size() > DEFAULT_LIMIT) {
            out.println("... " + (jobs.size() - DEFAULT_LIMIT) + " more; use 'job <id>' for detail.");
        }
    }

    private static String age(Instant when) {
        Duration age = Duration.between(when, Instant.now());
        if (age.toMinutes() > 0) {
            return age.toMinutes() + "m" + age.toSecondsPart() + "s";
        }
        return age.toSeconds() + "." + (age.toMillisPart() / 100) + "s";
    }
}
