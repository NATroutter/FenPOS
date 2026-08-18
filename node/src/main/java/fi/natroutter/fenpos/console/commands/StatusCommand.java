package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.FenPOS;
import fi.natroutter.fenpos.config.data.HttpSettings;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.print.PrintService;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/** Summarises the whole system: uptime, listener, devices and job totals. */
public class StatusCommand implements Command {

    private final ConsoleOutput out;
    private final PrintService printing;
    private final Instant startedAt;

    /**
     * @param out       output sink
     * @param printing  the print service
     * @param startedAt when the process started
     */
    public StatusCommand(ConsoleOutput out, PrintService printing, Instant startedAt) {
        this.out = Objects.requireNonNull(out, "out");
        this.printing = Objects.requireNonNull(printing, "printing");
        this.startedAt = Objects.requireNonNull(startedAt, "startedAt");
    }

    @Override
    public String name() {
        return "status";
    }

    @Override
    public String description() {
        return "Show uptime, listener and job totals";
    }

    @Override
    public void execute(String[] args) {
        HttpSettings http = printing.config().http();

        out.println("ThermAPI " + FenPOS.getVERSION());
        out.println("  Uptime:   " + humanise(Duration.between(startedAt, Instant.now())));
        out.println("  Listener: " + (http.enabled()
                ? http.host() + ":" + http.port()
                : "disabled"));
        out.println("  Devices:  " + printing.config().devices().size());
        out.println("  Jobs:     " + count(JobState.QUEUED) + " queued, "
                + count(JobState.PRINTING) + " printing, "
                + count(JobState.COMPLETED) + " completed, "
                + count(JobState.FAILED) + " failed, "
                + count(JobState.CANCELLED) + " cancelled");
        out.println("  (job counts cover the retention window only)");
    }

    private long count(JobState state) {
        return printing.jobs().all().stream().filter(job -> job.state() == state).count();
    }

    private static String humanise(Duration uptime) {
        long days = uptime.toDays();
        long hours = uptime.toHoursPart();
        long minutes = uptime.toMinutesPart();
        long seconds = uptime.toSecondsPart();
        if (days > 0) {
            return days + "d " + hours + "h " + minutes + "m";
        }
        if (hours > 0) {
            return hours + "h " + minutes + "m";
        }
        return minutes > 0 ? minutes + "m " + seconds + "s" : seconds + "s";
    }
}
