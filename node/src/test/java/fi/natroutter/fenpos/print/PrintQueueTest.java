package fi.natroutter.fenpos.print;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.config.data.JobSettings;
import fi.natroutter.fenpos.enums.ConnectionStatus;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.serial.FakePrinterPort;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link PrintQueue}, driven against a fake port so ordering,
 * capacity, pausing and failure handling are asserted without hardware.
 * <p>
 * The queue's worker is started explicitly, which lets a test stage jobs first and then
 * release them. That removes every race these tests would otherwise have, so the only
 * timed waits are the negative assertions — proving something does <em>not</em> happen
 * requires giving it the chance to.
 */
class PrintQueueTest {

    /** Generous upper bound for work that should complete almost instantly. */
    private static final long AWAIT_MILLIS = 5000;

    /** Window in which a job that must not print is given the opportunity to. */
    private static final long NEGATIVE_WINDOW_MILLIS = 250;

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(false)
            .build();

    private final JobStore store =
            new JobStore(new JobSettings(Duration.ofMinutes(10), 500, Duration.ofSeconds(5)),
                    Clock.systemUTC());

    private FakePrinterPort port;
    private PrintQueue queue;

    @AfterEach
    void stopQueue() {
        if (queue != null) {
            queue.shutdown(Duration.ofSeconds(2));
        }
    }

    @Test
    void printsSubmittedJobsInOrder() throws Exception {
        newQueue(3, 10);

        submit(1);
        submit(2);
        submit(3);
        queue.start();

        assertTrue(port.awaitWrites(AWAIT_MILLIS), "all three jobs should print");
        assertEquals(3, port.writes().size());
        assertEquals(1, port.writes().get(0)[0]);
        assertEquals(2, port.writes().get(1)[0]);
        assertEquals(3, port.writes().get(2)[0]);
    }

    @Test
    void marksAJobCompletedOnceWritten() throws Exception {
        newQueue(1, 10);

        PrintJob job = submit(1);
        queue.start();

        assertTrue(port.awaitWrites(AWAIT_MILLIS));
        awaitTerminal(job);
        assertEquals(JobState.COMPLETED, job.state());
        assertNotNull(job.startedAt());
        assertNotNull(job.finishedAt());
    }

    @Test
    void marksAJobFailedWhenTheWriteFails() throws Exception {
        newQueue(1, 10);
        port.failWrites();

        PrintJob job = submit(1);
        queue.start();

        assertTrue(port.awaitWrites(AWAIT_MILLIS));
        awaitTerminal(job);
        assertEquals(JobState.FAILED, job.state());
        assertNotNull(job.failureReason());
    }

    /**
     * One failed job must not stop the device: the next job is attempted normally.
     */
    @Test
    void keepsPrintingAfterAJobFails() throws Exception {
        newQueue(2, 10);
        port.failWrites();

        PrintJob failing = submit(1);
        PrintJob following = submit(2);
        queue.start();

        assertTrue(port.awaitWrites(AWAIT_MILLIS));
        awaitTerminal(failing);
        awaitTerminal(following);
        assertEquals(JobState.FAILED, failing.state());
        assertEquals(JobState.FAILED, following.state());
    }

    @Test
    void rejectsSubmissionWhenTheQueueIsFull() throws Exception {
        newQueue(1, 2);

        submit(1);
        submit(2);

        QueueRejectedException thrown = assertThrows(QueueRejectedException.class, () -> submit(3));
        assertEquals(QueueRejectedException.Reason.QUEUE_FULL, thrown.reason());
    }

    /**
     * A paused device refuses new work rather than accumulating it, so an operator who
     * paused to clear a jam does not find a backlog waiting when they resume.
     */
    @Test
    void rejectsSubmissionWhilePaused() throws Exception {
        newQueue(1, 10);
        queue.pause();

        QueueRejectedException thrown = assertThrows(QueueRejectedException.class, () -> submit(1));
        assertEquals(QueueRejectedException.Reason.DEVICE_PAUSED, thrown.reason());
    }

    @Test
    void rejectsSubmissionWhenTheDeviceIsNotOpen() throws Exception {
        newQueue(1, 10);
        port.setStatus(ConnectionStatus.NO_DEVICE);

        QueueRejectedException thrown = assertThrows(QueueRejectedException.class, () -> submit(1));
        assertEquals(QueueRejectedException.Reason.DEVICE_UNAVAILABLE, thrown.reason());
    }

    @Test
    void aPausedQueueHoldsAlreadyAcceptedJobsUntilResumed() throws Exception {
        newQueue(1, 10);

        submit(1);
        queue.pause();
        queue.start();

        assertFalse(port.awaitWrites(NEGATIVE_WINDOW_MILLIS), "must not print while paused");
        assertEquals(1, queue.depth(), "the job stays queued rather than being dropped");

        queue.resume();
        assertTrue(port.awaitWrites(AWAIT_MILLIS), "must print once resumed");
    }

    @Test
    void aCancelledJobIsNeverPrinted() throws Exception {
        newQueue(1, 10);

        PrintJob cancelled = submit(1);
        PrintJob wanted = submit(2);
        assertTrue(cancelled.cancel());
        queue.start();

        assertTrue(port.awaitWrites(AWAIT_MILLIS));
        awaitTerminal(wanted);
        assertEquals(1, port.writes().size(), "only the surviving job should print");
        assertEquals(2, port.writes().getFirst()[0]);
        assertEquals(JobState.CANCELLED, cancelled.state());
    }

    @Test
    void clearCancelsEveryQueuedJob() throws Exception {
        newQueue(1, 10);

        PrintJob first = submit(1);
        PrintJob second = submit(2);

        assertEquals(2, queue.clear());
        assertEquals(JobState.CANCELLED, first.state());
        assertEquals(JobState.CANCELLED, second.state());
        assertEquals(0, queue.depth());
    }

    /**
     * Restarting must not resurrect work: a receipt printed hours after it was requested is
     * worse than one never printed.
     */
    @Test
    void shutdownCancelsQueuedJobs() throws Exception {
        newQueue(1, 10);

        PrintJob job = submit(1);
        queue.shutdown(Duration.ofSeconds(2));
        queue = null;

        assertEquals(JobState.CANCELLED, job.state());
    }

    @Test
    void submissionAfterShutdownIsRefused() throws Exception {
        newQueue(1, 10);
        queue.shutdown(Duration.ofSeconds(2));

        assertThrows(QueueRejectedException.class, () -> submit(1));
        queue = null;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private void newQueue(int expectedWrites, int capacity) {
        port = new FakePrinterPort(expectedWrites);
        queue = new PrintQueue(port, capacity, logger);
    }

    private PrintJob submit(int marker) throws QueueRejectedException {
        PrintJob job = store.create("fake", new CompiledJob(new byte[]{(byte) marker}, 1));
        queue.submit(job);
        return job;
    }

    /** Spins briefly for the state change the worker applies just after its write returns. */
    private static void awaitTerminal(PrintJob job) {
        long deadline = System.nanoTime() + Duration.ofMillis(AWAIT_MILLIS).toNanos();
        while (!job.isTerminal() && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertTrue(job.isTerminal(), "job should have reached a terminal state");
    }
}
