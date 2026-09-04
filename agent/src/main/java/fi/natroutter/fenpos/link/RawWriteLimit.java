package fi.natroutter.fenpos.link;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * How often one device will take a raw write.
 *
 * <p>A token bucket per device: ten in hand, five a second back. An operator on the Tools tab
 * never approaches that, and a server driving a print head continuously does immediately.
 *
 * <p><strong>What this is not.</strong> It does not make the hardware safe from a compromised
 * server, which can still burn paper by dispatching jobs, and nothing bounds that. It covers
 * the one path with nothing else in it: a raw write goes straight to the port, with no queue,
 * no depth cap and no ordering against anything else, so it is the only place a server reaches
 * a print head with none of this agent's machinery in between.
 */
final class RawWriteLimit {

    /** Writes allowed in one burst, which is also the bucket's size. */
    private static final double BURST = 10;

    /** Writes given back per second. */
    private static final double PER_SECOND = 5;

    private final Supplier<Instant> clock;
    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

    RawWriteLimit(Supplier<Instant> clock) {
        this.clock = clock;
    }

    /**
     * Takes one write's worth of allowance for a device.
     *
     * @param device the device the write is for
     * @return whether the write may proceed
     */
    boolean allow(String device) {
        Instant now = clock.get();
        Bucket bucket = buckets.computeIfAbsent(device, ignored -> new Bucket(now));
        synchronized (bucket) {
            double elapsed = Duration.between(bucket.refilled, now).toMillis() / 1000.0;
            bucket.tokens = Math.min(BURST, bucket.tokens + elapsed * PER_SECOND);
            bucket.refilled = now;
            if (bucket.tokens < 1) {
                return false;
            }
            bucket.tokens -= 1;
            return true;
        }
    }

    /** Removes the bucket for a device the agent no longer has. */
    void forget(String device) {
        buckets.remove(device);
    }

    private static final class Bucket {
        private double tokens = BURST;
        private Instant refilled;

        private Bucket(Instant now) {
            this.refilled = now;
        }
    }
}
