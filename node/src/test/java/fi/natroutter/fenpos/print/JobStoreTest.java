package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.config.data.JobSettings;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link JobStore}.
 * <p>
 * Time is supplied by a movable clock rather than by sleeping, so retention behaviour is
 * asserted exactly and the suite stays fast and deterministic.
 */
class JobStoreTest {

    private final MovableClock clock = new MovableClock(Instant.parse("2026-08-17T10:00:00Z"));

    @Test
    void storesAndFindsAJob() {
        JobStore store = store(Duration.ofMinutes(10), 500);
        PrintJob job = store.create("kitchen", compiled());

        assertTrue(store.find(job.id()).isPresent());
        assertEquals(job, store.find(job.id()).orElseThrow());
    }

    @Test
    void generatesDistinctIdentifiers() {
        JobStore store = store(Duration.ofMinutes(10), 500);

        Set<String> ids = new HashSet<>();
        for (int index = 0; index < 500; index++) {
            ids.add(store.create("kitchen", compiled()).id());
        }

        assertEquals(500, ids.size(), "identifiers must be unique");
    }

    @Test
    void identifiersAreShortHexStrings() {
        JobStore store = store(Duration.ofMinutes(10), 500);

        assertTrue(store.create("kitchen", compiled()).id().matches("[0-9a-f]{8}"));
    }

    @Test
    void evictsFinishedJobsOnceRetentionHasPassed() {
        JobStore store = store(Duration.ofMinutes(10), 500);
        PrintJob job = store.create("kitchen", compiled());
        job.complete();

        clock.advance(Duration.ofMinutes(9));
        store.evictExpired();
        assertTrue(store.find(job.id()).isPresent(), "still inside retention");

        clock.advance(Duration.ofMinutes(2));
        store.evictExpired();
        assertFalse(store.find(job.id()).isPresent(), "past retention");
    }

    /**
     * A job still waiting or printing must survive regardless of age: evicting it would
     * lose the only record that work is outstanding.
     */
    @Test
    void neverEvictsAJobThatHasNotFinished() {
        JobStore store = store(Duration.ofMinutes(10), 500);
        PrintJob queued = store.create("kitchen", compiled());

        clock.advance(Duration.ofHours(5));
        store.evictExpired();

        assertTrue(store.find(queued.id()).isPresent());
    }

    /**
     * Retention alone does not bound memory: a client printing faster than jobs expire
     * would grow the map without limit, so a hard cap applies too.
     */
    @Test
    void enforcesTheRecordCapByDroppingOldestFinishedJobsFirst() {
        JobStore store = store(Duration.ofMinutes(10), 3);

        PrintJob oldest = store.create("kitchen", compiled());
        oldest.complete();
        clock.advance(Duration.ofSeconds(1));

        PrintJob middle = store.create("kitchen", compiled());
        middle.complete();
        clock.advance(Duration.ofSeconds(1));

        PrintJob newest = store.create("kitchen", compiled());
        newest.complete();
        clock.advance(Duration.ofSeconds(1));

        store.create("kitchen", compiled());

        assertFalse(store.find(oldest.id()).isPresent(), "oldest finished job should go first");
        assertTrue(store.find(middle.id()).isPresent());
        assertTrue(store.find(newest.id()).isPresent());
    }

    @Test
    void capNeverDropsAnUnfinishedJob() {
        JobStore store = store(Duration.ofMinutes(10), 2);

        PrintJob queued = store.create("kitchen", compiled());
        clock.advance(Duration.ofSeconds(1));
        for (int index = 0; index < 5; index++) {
            store.create("kitchen", compiled()).complete();
            clock.advance(Duration.ofSeconds(1));
        }

        assertTrue(store.find(queued.id()).isPresent());
    }

    @Test
    void listsJobsForOneDeviceNewestFirst() {
        JobStore store = store(Duration.ofMinutes(10), 500);
        PrintJob first = store.create("kitchen", compiled());
        clock.advance(Duration.ofSeconds(1));
        PrintJob second = store.create("kitchen", compiled());
        clock.advance(Duration.ofSeconds(1));
        store.create("bar", compiled());

        var kitchen = store.forDevice("kitchen");

        assertEquals(2, kitchen.size());
        assertEquals(second.id(), kitchen.get(0).id(), "newest first");
        assertEquals(first.id(), kitchen.get(1).id());
    }

    private JobStore store(Duration retention, int maxRecords) {
        return new JobStore(new JobSettings(retention, maxRecords, Duration.ofSeconds(10)), clock);
    }

    private static CompiledJob compiled() {
        return new CompiledJob(new byte[]{1, 2, 3}, 1);
    }

    /** A clock the test moves by hand, so retention is exercised without waiting. */
    private static final class MovableClock extends Clock {
        private Instant now;

        MovableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration amount) {
            now = now.plus(amount);
        }

        @Override
        public Instant instant() {
            return now;
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }
    }
}
