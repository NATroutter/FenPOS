package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.config.data.JobSettings;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Holds job records in memory and bounds how many survive.
 * <p>
 * Deliberately not persistent. A receipt printer is a physical device, and a job resurrected
 * after a restart would print something the customer stopped waiting for long ago. Losing
 * pending work on restart is the safer failure.
 * <p>
 * Two independent bounds keep memory finite: records expire after a retention period, and a
 * hard cap drops the oldest finished records when a client creates jobs faster than they
 * expire. Neither bound ever removes a job that has not finished, because that record is the
 * only evidence that work is outstanding.
 */
public class JobStore {

    /**
     * Identifier length in hex characters. Short enough to read aloud from a console,
     * while 4.3 billion values make reuse within a retention window a non-issue.
     */
    private static final int ID_LENGTH = 8;

    private static final int ID_BYTES = ID_LENGTH / 2;

    private final Map<String, PrintJob> jobs = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final JobSettings settings;
    private final Clock clock;

    /**
     * @param settings retention and cap settings
     * @param clock    time source; injected so retention can be tested without waiting
     */
    public JobStore(JobSettings settings, Clock clock) {
        this.settings = Objects.requireNonNull(settings, "settings");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * Creates and registers a job for a compiled payload.
     *
     * @param deviceName the device the job prints on
     * @param compiled   the compiled payload
     * @return the registered job, in {@link fi.natroutter.fenpos.enums.JobState#QUEUED}
     */
    public PrintJob create(String deviceName, CompiledJob compiled) {
        PrintJob job = new PrintJob(nextId(), deviceName, compiled, clock);
        jobs.put(job.id(), job);
        enforceCap();
        return job;
    }

    /**
     * Looks up a job.
     *
     * @param id the job identifier; may be {@code null}
     * @return the job, or empty if unknown or already evicted
     */
    public Optional<PrintJob> find(String id) {
        return id == null ? Optional.empty() : Optional.ofNullable(jobs.get(id));
    }

    /**
     * Returns the jobs belonging to one device, newest first.
     *
     * @param deviceName the device name
     * @return a snapshot list; never {@code null}
     */
    public List<PrintJob> forDevice(String deviceName) {
        return jobs.values().stream()
                .filter(job -> job.deviceName().equals(deviceName))
                .sorted(Comparator.comparing(PrintJob::queuedAt).reversed())
                .toList();
    }

    /** Returns every job, newest first. */
    public List<PrintJob> all() {
        return jobs.values().stream()
                .sorted(Comparator.comparing(PrintJob::queuedAt).reversed())
                .toList();
    }

    /**
     * Removes finished jobs older than the retention period.
     * <p>
     * Exposed rather than private so it can be driven directly by a scheduler and asserted
     * directly by tests.
     */
    public void evictExpired() {
        Instant cutoff = clock.instant().minus(settings.retention());
        jobs.values().removeIf(job -> {
            // PrintJob sets finishedAt only on complete, fail and cancel, so a non-null
            // value is exactly equivalent to the job being terminal. Testing both would be
            // testing the same condition twice.
            Instant finished = job.finishedAt();
            return finished != null && finished.isBefore(cutoff);
        });
    }

    /** Returns how many records are currently held. */
    public int size() {
        return jobs.size();
    }

    /**
     * Drops the oldest finished records until the store is back within its cap.
     * <p>
     * Unfinished jobs are skipped entirely, so a device with a long backlog is never
     * silently forgotten; the cap is a bound on history, not on outstanding work.
     */
    private void enforceCap() {
        int excess = jobs.size() - settings.maxRecords();
        if (excess <= 0) {
            return;
        }
        jobs.values().stream()
                .filter(PrintJob::isTerminal)
                .sorted(Comparator.comparing(PrintJob::queuedAt))
                .limit(excess)
                .toList()
                .forEach(job -> jobs.remove(job.id()));
    }

    /**
     * Generates an identifier not currently in use.
     * <p>
     * Retries on collision rather than assuming uniqueness: with retention holding hundreds
     * of records the birthday bound is small but not zero, and a duplicate would silently
     * overwrite another job's record.
     */
    private String nextId() {
        byte[] buffer = new byte[ID_BYTES];
        while (true) {
            random.nextBytes(buffer);
            StringBuilder id = new StringBuilder(ID_LENGTH);
            for (byte value : buffer) {
                id.append(String.format("%02x", value));
            }
            String candidate = id.toString();
            if (!jobs.containsKey(candidate)) {
                return candidate;
            }
        }
    }
}
