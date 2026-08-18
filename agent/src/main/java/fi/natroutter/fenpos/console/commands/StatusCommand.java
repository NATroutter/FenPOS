package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.FenPOSAgent;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.store.AgentIdentity;
import fi.natroutter.fenpos.store.AgentStore;
import fi.natroutter.fenpos.store.StoreException;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/** Summarises the whole agent: uptime, who it is paired to, devices and job totals. */
public class StatusCommand implements Command {

    private final ConsoleOutput out;
    private final PrintService printing;
    private final AgentStore store;
    private final Instant startedAt;

    /**
     * @param out       output sink
     * @param printing  the print service
     * @param store     the local store, for the pairing identity
     * @param startedAt when the process started
     */
    public StatusCommand(ConsoleOutput out,
                         PrintService printing,
                         AgentStore store,
                         Instant startedAt) {
        this.out = Objects.requireNonNull(out, "out");
        this.printing = Objects.requireNonNull(printing, "printing");
        this.store = Objects.requireNonNull(store, "store");
        this.startedAt = Objects.requireNonNull(startedAt, "startedAt");
    }

    @Override
    public String name() {
        return "status";
    }

    @Override
    public String description() {
        return "Show uptime, pairing, devices and job totals";
    }

    @Override
    public void execute(String[] args) {
        out.println("FenPOS agent " + FenPOSAgent.getVERSION());
        out.println("  Uptime:   " + humanise(Duration.between(startedAt, Instant.now())));
        out.println("  Paired:   " + pairing());
        out.println("  Devices:  " + printing.devices().size());
        out.println("  Jobs:     " + count(JobState.QUEUED) + " queued, "
                + count(JobState.PRINTING) + " printing, "
                + count(JobState.COMPLETED) + " completed, "
                + count(JobState.FAILED) + " failed, "
                + count(JobState.CANCELLED) + " cancelled");
        out.println("  (job counts cover the retention window only)");
    }

    /**
     * Describes who this agent is paired to.
     * <p>
     * A store failure is reported rather than thrown, because the point of {@code status} is
     * to be usable when something is wrong.
     */
    private String pairing() {
        try {
            Optional<AgentIdentity> identity = store.identity();
            return identity
                    .map(id -> id.agentName() + " at " + id.serverUrl())
                    .orElse("no (run 'pair <url> <code>')");
        } catch (StoreException e) {
            return "unknown; the local store could not be read: " + e.getMessage();
        }
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
