package fi.natroutter.fenpos.print;


import fi.natroutter.foxlib.logger.FoxLogger;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
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

    /**
     * Job identifiers this agent has accepted, whether or not their records still exist.
     *
     * <p>Separate from {@link #jobs} because the two answer different questions with different
     * lifetimes. A record is what the panel reads and is meant to expire: retention drops it, and
     * the record cap drops it, and both of those are set by the server. An identity is what makes
     * a repeat dispatch recognisable, and forgetting one means printing a receipt twice, which
     * costs whoever is holding the paper. Tying the second to the first made "deduplicated by id"
     * a promise about a window the server could shrink to a minute.
     *
     * <p>Bounded rather than kept forever, oldest forgotten first. Ten thousand identifiers of at
     * most 64 characters is a megabyte or two, and at a thousand receipts a day it is ten days of
     * deduplication, which is far longer than any retry a link could produce.
     */
    private static final int MAX_SEEN_IDS = 10_000;

    private final Map<String, Boolean> seen = Collections.synchronizedMap(
            new LinkedHashMap<>(256, 0.75f, false) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                    return size() > MAX_SEEN_IDS;
                }
            });

    private final SecureRandom random = new SecureRandom();
    private final Clock clock;

    /** Handed to every job it creates, so a listener that throws is reported rather than lost. */
    private final FoxLogger logger;

    /**
     * Notified on every state change. Volatile because it is set once the link exists, which is
     * after the store has been constructed and while queue workers may already be running.
     */
    private volatile JobListener listener = JobListener.NONE;

    /**
     * Retention and cap settings. Volatile for the same reason as {@link #listener}: the server
     * pushes these with {@code config.sync}, which arrives after construction and while queue
     * workers may already be running.
     */
    private volatile JobSettings settings;

    /**
     * @param settings retention and cap settings
     * @param clock    time source; injected so retention can be tested without waiting
     * @param logger   passed to every job created here
     */
    public JobStore(JobSettings settings, Clock clock, FoxLogger logger) {
        this.settings = Objects.requireNonNull(settings, "settings");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.logger = Objects.requireNonNull(logger, "logger");
    }

    /**
     * Sets who is told about state changes.
     * <p>
     * Applies to jobs created from now on. Jobs already in flight keep the listener they were
     * created with, which is what makes this safe to call while the queues are running.
     *
     * @param listener the listener, or {@link JobListener#NONE} to stop reporting
     */
    public void listener(JobListener listener) {
        this.listener = Objects.requireNonNull(listener, "listener");
    }

    /**
     * Replaces the retention and cap settings.
     *
     * <p>The new cap is enforced on the next write rather than immediately. Evicting on the setter
     * would mean a {@code config.sync} deleting records while a console command is reading them,
     * and the next write is never far away on an agent doing anything at all.
     *
     * @param settings the settings to apply from now on
     */
    public void settings(JobSettings settings) {
        this.settings = Objects.requireNonNull(settings, "settings");
    }

    /**
     * Creates and registers a job for a compiled payload.
     *
     * @param deviceName the device the job prints on
     * @param compiled   the compiled payload
     * @return the registered job, in {@link fi.natroutter.fenpos.enums.JobState#QUEUED}
     */
    public PrintJob create(String deviceName, CompiledJob compiled) {
        return register(new PrintJob(nextId(), deviceName, compiled, clock, listener, logger));
    }

    /**
     * Registers a job under an identifier the server assigned, refusing a repeat.
     * <p>
     * Deduplication lives here because the identifier is what makes it possible. Nothing else on
     * this side can tell a fresh dispatch from a second copy of one already printed, and a receipt
     * printed twice is a real cost to whoever is holding the paper — so a repeat is checked for
     * rather than assumed away, whatever produced it. Returning empty rather than throwing keeps
     * the caller simple: a duplicate is something this boundary absorbs, not a fault to report.
     *
     * @param id         the server's job identifier
     * @param deviceName the device the job prints on
     * @param compiled   the compiled payload
     * @return the registered job, or empty if this identifier is already known
     */
    public Optional<PrintJob> adopt(String id, String deviceName, CompiledJob compiled) {
        Objects.requireNonNull(id, "id");
        if (seen.putIfAbsent(id, Boolean.TRUE) != null) {
            return Optional.empty();
        }
        PrintJob job = new PrintJob(id, deviceName, compiled, clock, listener, logger);
        if (jobs.putIfAbsent(id, job) != null) {
            return Optional.empty();
        }
        enforceCap();
        return Optional.of(job);
    }

    /** Registers a job and applies the retention cap. */
    private PrintJob register(PrintJob job) {
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
