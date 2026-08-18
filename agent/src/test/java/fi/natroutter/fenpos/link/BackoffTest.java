package fi.natroutter.fenpos.link;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for the reconnect delay.
 * <p>
 * The bounds are asserted rather than exact values, because the delay is deliberately random
 * within a band — a test that pinned it to a number would be asserting the absence of the
 * jitter that stops every agent retrying in lockstep.
 */
class BackoffTest {

    /** The jitter band, as a fraction either side of the computed delay. */
    private static final double JITTER = 0.2;

    @Test
    void startsAroundOneSecond() {
        Duration first = new Backoff().next();

        assertWithinJitter(Duration.ofSeconds(1), first);
    }

    @Test
    void doublesUntilItReachesTheCeiling() {
        Backoff backoff = new Backoff();

        assertWithinJitter(Duration.ofSeconds(1), backoff.next());
        assertWithinJitter(Duration.ofSeconds(2), backoff.next());
        assertWithinJitter(Duration.ofSeconds(4), backoff.next());
        assertWithinJitter(Duration.ofSeconds(8), backoff.next());
    }

    @Test
    void holdsAtAMinuteRatherThanGrowingForever() {
        Backoff backoff = new Backoff();
        for (int attempt = 0; attempt < 40; attempt++) {
            backoff.next();
        }

        // A shop whose internet returns overnight should reconnect within a minute of it
        // coming back, not still be backed off to an hour.
        assertWithinJitter(Duration.ofSeconds(60), backoff.next());
    }

    @Test
    void neverReturnsANonPositiveDelay() {
        Backoff backoff = new Backoff();
        for (int attempt = 0; attempt < 100; attempt++) {
            assertTrue(backoff.next().toMillis() >= 1, "delay must be at least a millisecond");
        }
    }

    @Test
    void spreadsDelaysSoAgentsDoNotRetryInLockstep() {
        Set<Long> observed = new HashSet<>();
        for (int agent = 0; agent < 50; agent++) {
            Backoff backoff = new Backoff();
            backoff.next();
            backoff.next();
            observed.add(backoff.next().toMillis());
        }

        // Fifty agents disconnected by one server restart must not all come back at the same
        // instant. Exact values vary; what matters is that they are not one value.
        assertTrue(observed.size() > 5,
                "expected jittered delays to differ, saw " + observed.size() + " distinct values");
    }

    @Test
    void returnsToTheStartAfterAConnectionSucceeds() {
        Backoff backoff = new Backoff();
        backoff.next();
        backoff.next();
        backoff.next();

        backoff.reset();

        assertEquals(0, backoff.attempts());
        assertWithinJitter(Duration.ofSeconds(1), backoff.next());
    }

    @Test
    void countsAttemptsSinceTheLastSuccess() {
        Backoff backoff = new Backoff();
        backoff.next();
        backoff.next();

        assertEquals(2, backoff.attempts());
    }

    private static void assertWithinJitter(Duration expected, Duration actual) {
        long lower = (long) (expected.toMillis() * (1 - JITTER)) - 1;
        long upper = (long) (expected.toMillis() * (1 + JITTER)) + 1;
        assertTrue(actual.toMillis() >= lower && actual.toMillis() <= upper,
                "expected roughly " + expected + " but got " + actual);
    }
}
