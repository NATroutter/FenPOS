package fi.natroutter.fenpos.print;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.serial.PrinterPort;
import fi.natroutter.fenpos.serial.PrinterWriteException;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The pending work for one printer, drained by a single worker.
 * <p>
 * One queue and one worker per device is what keeps devices independent: a jammed or
 * disconnected printer holds up only its own work, never another device's. A single worker
 * also means jobs reach the paper in submission order without any further coordination.
 * <p>
 * The queue holds fully compiled payloads, so a job that gets this far can only fail for
 * hardware reasons. Submission is refused rather than deferred when the device cannot print
 * — accepting work for an unplugged printer only converts an immediate, actionable error
 * into a receipt that appears at an unpredictable time.
 * <p>
 * The worker is started explicitly by {@link #start()} rather than by the constructor, so
 * ownership of the thread is visible at the call site and startup can stage state before
 * anything begins printing.
 */
public class PrintQueue {

    /**
     * How long the worker waits for a job before looping.
     * <p>
     * Bounded rather than indefinite so pausing and shutdown are noticed promptly without
     * needing to interrupt a thread that may be mid-write.
     */
    private static final Duration POLL_INTERVAL = Duration.ofMillis(100);

    private final PrinterPort port;
    private final BlockingQueue<PrintJob> pending;
    private final FoxLogger logger;

    private final ReentrantLock pauseLock = new ReentrantLock();
    private final Condition resumed = pauseLock.newCondition();

    /** Lifecycle of the queue itself, distinct from whether an operator has paused it. */
    private enum State {
        /** Created; jobs may be staged but nothing is being printed yet. */
        NEW,
        /** Worker running. */
        RUNNING,
        /** Shut down for good; no further work is accepted. */
        STOPPED
    }

    private volatile State state = State.NEW;
    private volatile boolean paused;
    private volatile Thread worker;

    /** The job currently being written, so shutdown can report it honestly. */
    private volatile PrintJob inFlight;

    /**
     * @param port     the device this queue feeds
     * @param capacity most jobs allowed to be pending at once
     * @param logger   logger for job lifecycle messages
     */
    public PrintQueue(PrinterPort port, int capacity, FoxLogger logger) {
        this.port = Objects.requireNonNull(port, "port");
        this.logger = Objects.requireNonNull(logger, "logger");
        if (capacity < 1) {
            throw new IllegalArgumentException("capacity must be at least 1, got " + capacity);
        }
        this.pending = new ArrayBlockingQueue<>(capacity);
    }

    /** Starts the worker. Does nothing if it is already running or has been shut down. */
    public void start() {
        if (state != State.NEW) {
            return;
        }
        state = State.RUNNING;
        worker = Thread.ofVirtual()
                .name("thermapi-printer-" + port.deviceName())
                .start(this::drain);
    }

    // -------------------------------------------------------------------------
    // Submission
    // -------------------------------------------------------------------------

    /**
     * Accepts a compiled job for printing.
     *
     * @param job the job to print
     * @throws QueueRejectedException if the device is closed, paused, or already has as many
     *                                jobs pending as it is allowed
     */
    public void submit(PrintJob job) throws QueueRejectedException {
        if (state == State.STOPPED) {
            throw new QueueRejectedException(QueueRejectedException.Reason.DEVICE_UNAVAILABLE,
                    "Device " + port.deviceName() + " is shutting down");
        }
        if (paused) {
            throw new QueueRejectedException(QueueRejectedException.Reason.DEVICE_PAUSED,
                    "Device " + port.deviceName() + " is paused");
        }
        if (!port.isOpen()) {
            throw new QueueRejectedException(QueueRejectedException.Reason.DEVICE_UNAVAILABLE,
                    "Device " + port.deviceName() + " is " + port.status().getLabel());
        }
        if (!pending.offer(job)) {
            throw new QueueRejectedException(QueueRejectedException.Reason.QUEUE_FULL,
                    "Device " + port.deviceName() + " already has "
                            + pending.size() + " jobs waiting");
        }
    }

    // -------------------------------------------------------------------------
    // Operator control
    // -------------------------------------------------------------------------

    /** Stops feeding the printer, leaving queued jobs in place. */
    public void pause() {
        paused = true;
        logger.info("[" + port.deviceName() + "] Printing paused");
    }

    /** Resumes feeding the printer. */
    public void resume() {
        pauseLock.lock();
        try {
            paused = false;
            resumed.signalAll();
        } finally {
            pauseLock.unlock();
        }
        logger.info("[" + port.deviceName() + "] Printing resumed");
    }

    /** Returns whether the device is currently paused. */
    public boolean isPaused() {
        return paused;
    }

    /** Returns how many jobs are waiting, excluding any currently being written. */
    public int depth() {
        return pending.size();
    }

    /** Returns the jobs currently waiting, in printing order. */
    public List<PrintJob> pendingJobs() {
        return List.copyOf(pending);
    }

    /**
     * Cancels every waiting job.
     *
     * @return how many jobs were cancelled
     */
    public int clear() {
        List<PrintJob> drained = new ArrayList<>();
        pending.drainTo(drained);
        int cancelled = 0;
        for (PrintJob job : drained) {
            if (job.cancel()) {
                cancelled++;
            }
        }
        logger.info("[" + port.deviceName() + "] Cleared " + cancelled + " queued job(s)");
        return cancelled;
    }

    // -------------------------------------------------------------------------
    // Worker
    // -------------------------------------------------------------------------

    private void drain() {
        while (state == State.RUNNING) {
            try {
                awaitResume();
                if (state != State.RUNNING) {
                    return;
                }
                PrintJob job = pending.poll(POLL_INTERVAL.toMillis(), TimeUnit.MILLISECONDS);
                if (job != null) {
                    print(job);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void awaitResume() throws InterruptedException {
        pauseLock.lock();
        try {
            while (paused && state == State.RUNNING) {
                resumed.await(POLL_INTERVAL.toMillis(), TimeUnit.MILLISECONDS);
            }
        } finally {
            pauseLock.unlock();
        }
    }

    /**
     * Writes one job, recording the outcome.
     * <p>
     * A failure is logged and the loop continues: one unprintable job must not take the
     * device out of service for every job behind it.
     */
    private void print(PrintJob job) {
        if (!job.beginPrinting()) {
            // Cancelled between submission and now; skip it silently.
            return;
        }
        inFlight = job;
        try {
            port.write(job.payload());
            job.complete();
            logger.info("[" + port.deviceName() + "] Printed job " + job.id()
                    + " (" + job.lines() + " lines, " + job.bytes() + " bytes)");
        } catch (PrinterWriteException e) {
            job.fail(e.getMessage());
            logger.error("[" + port.deviceName() + "] Job " + job.id() + " failed: "
                    + e.getMessage());
        } finally {
            inFlight = null;
        }
    }

    // -------------------------------------------------------------------------
    // Shutdown
    // -------------------------------------------------------------------------

    /**
     * Stops the worker and settles every outstanding job.
     * <p>
     * Waiting jobs are cancelled rather than kept, because nothing persists them and a job
     * that survived a restart could print long after anyone wanted it. A job still being
     * written when the grace period expires is marked failed rather than completed: a
     * serial write cannot be interrupted, so its true outcome is unknown, and claiming
     * success would be a guess.
     *
     * @param grace how long to wait for an in-flight job to finish
     */
    public void shutdown(Duration grace) {
        state = State.STOPPED;
        resume();

        int cancelled = 0;
        List<PrintJob> drained = new ArrayList<>();
        pending.drainTo(drained);
        for (PrintJob job : drained) {
            if (job.cancel()) {
                cancelled++;
            }
        }

        Thread current = worker;
        if (current != null) {
            try {
                current.join(grace.toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (current.isAlive()) {
                current.interrupt();
            }
        }

        PrintJob stranded = inFlight;
        if (stranded != null && !stranded.isTerminal()) {
            stranded.fail("Shutdown while printing; outcome unknown");
        }

        worker = null;
        if (cancelled > 0) {
            logger.info("[" + port.deviceName() + "] Cancelled " + cancelled
                    + " queued job(s) during shutdown");
        }
    }
}
