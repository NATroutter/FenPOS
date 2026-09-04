package fi.natroutter.fenpos.link;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * How many raw writes one device will take.
 *
 * <p>This does not make the hardware safe from a compromised server, which can still burn paper
 * through ordinary job dispatch, and nothing bounds that. It covers the one path that has
 * nothing else in it: a raw write goes straight to the port, with no queue, no depth cap and no
 * ordering against anything else, so it is the only place where a server reaches a print head
 * with nothing of this agent's in between.
 */
class RawWriteLimitTest {

    private Instant now = Instant.parse("2026-09-04T10:00:00Z");
    private final RawWriteLimit limit = new RawWriteLimit(() -> now);

    @Test
    void allowsABurstAndThenRefuses() {
        for (int write = 1; write <= 10; write++) {
            assertTrue(limit.allow("kitchen"), "write " + write + " should be allowed");
        }
        assertFalse(limit.allow("kitchen"), "the eleventh write in one instant exceeds the burst");
    }

    @Test
    void refillsOverTime() {
        for (int write = 0; write < 10; write++) {
            limit.allow("kitchen");
        }
        assertFalse(limit.allow("kitchen"));

        now = now.plus(Duration.ofSeconds(1));

        // Five a second, so one second buys five.
        for (int write = 1; write <= 5; write++) {
            assertTrue(limit.allow("kitchen"), "write " + write + " after a second");
        }
        assertFalse(limit.allow("kitchen"));
    }

    @Test
    void countsEachDeviceOnItsOwn() {
        for (int write = 0; write < 10; write++) {
            limit.allow("kitchen");
        }
        assertFalse(limit.allow("kitchen"));

        // A printer being hammered must not stop an operator debugging a different one.
        assertTrue(limit.allow("bar"));
    }
}
