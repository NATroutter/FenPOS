package fi.natroutter.fenpos.link;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

/**
 * How long to wait before the next connection attempt.
 * <p>
 * Doubles from one second to a minute, then holds. The ceiling matters as much as the growth: a
 * shop whose internet is out overnight should be reconnected within a minute of it returning,
 * not still backed off to an hour.
 * <p>
 * <strong>The jitter is not decoration.</strong> When a server restarts, every agent it was
 * serving is disconnected in the same instant. Without jitter they would all retry in lockstep,
 * arriving together in waves that get larger as the delay grows — a self-inflicted denial of
 * service against a server that has just come back up and is at its most fragile. Spreading each
 * delay across a random band breaks the synchronisation permanently.
 */
public class Backoff {

    /** Delay before the first retry. */
    private static final Duration INITIAL = Duration.ofSeconds(1);

    /** Longest delay between retries. */
    private static final Duration MAXIMUM = Duration.ofSeconds(60);

    /** Fraction of the computed delay that is randomised, either side of it. */
    private static final double JITTER = 0.2;

    private long attempt;

    /**
     * Returns the delay before the next attempt and advances the sequence.
     *
     * @return how long to wait
     */
    public synchronized Duration next() {
        long base = Math.min(
                MAXIMUM.toMillis(),
                INITIAL.toMillis() << Math.min(attempt, 20));
        attempt++;

        long spread = (long) (base * JITTER);
        long jittered = spread == 0
                ? base
                : base - spread + ThreadLocalRandom.current().nextLong(2 * spread + 1);
        return Duration.ofMillis(Math.max(1, jittered));
    }

    /** Returns to the initial delay, after a connection that succeeded. */
    public synchronized void reset() {
        attempt = 0;
    }

    /** Returns how many delays have been handed out since the last reset. */
    public synchronized long attempts() {
        return attempt;
    }
}
