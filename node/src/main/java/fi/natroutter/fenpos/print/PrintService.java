package fi.natroutter.fenpos.print;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import fi.natroutter.fenpos.serial.PrinterPort;

import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Ties the compile pipeline, the job store and the per-device queues together.
 * <p>
 * Exists so the HTTP endpoints and the console command onto the same behaviour rather than
 * each assembling the pieces themselves; printing from the console and printing over HTTP
 * must not be able to drift apart.
 */
public class PrintService {

    private final ResolvedConfig config;
    private final JobStore jobs;
    private final Map<String, PrintQueue> queues = new LinkedHashMap<>();
    private final FoxLogger logger;

    /**
     * Supplies the port for a device.
     * <p>
     * Taken as a function rather than as a {@link DeviceConnectionManager} so the service
     * can be assembled over fake ports. That is what allows the HTTP layer to be exercised
     * end to end — request in, job record out — without a serial device attached.
     */
    @FunctionalInterface
    public interface PortLookup {

        /**
         * @param deviceName the configured device name
         * @return the port, or empty if no such device exists
         */
        Optional<PrinterPort> port(String deviceName);
    }

    /**
     * Creates a queue for every configured device, without starting any of them.
     *
     * @param config the resolved configuration
     * @param ports  supplies each device's port
     * @param clock  time source for job timestamps
     * @param logger logger for job lifecycle messages
     */
    public PrintService(ResolvedConfig config, PortLookup ports, Clock clock, FoxLogger logger) {
        this.config = Objects.requireNonNull(config, "config");
        this.logger = Objects.requireNonNull(logger, "logger");
        this.jobs = new JobStore(config.jobs(), Objects.requireNonNull(clock, "clock"));

        config.devices().forEach((name, device) -> {
            PrinterPort port = ports.port(name).orElseThrow(() ->
                    new IllegalStateException("No port registered for device " + name));
            queues.put(name, new PrintQueue(port, device.limits().maxQueueDepth(), logger));
        });
    }

    /** Starts every device's worker. */
    public void start() {
        queues.values().forEach(PrintQueue::start);
        logger.info("Print queues started for " + queues.size() + " device(s)");
    }

    /**
     * Compiles a request body and queues it for printing.
     *
     * @param device the authorised target device
     * @param body   the raw JSON request body
     * @return the queued job
     * @throws PrintRequestException  if the request cannot be printed as given
     * @throws QueueRejectedException if the device cannot accept work right now
     */
    public PrintJob submit(DeviceSettings device, String body)
            throws PrintRequestException, QueueRejectedException {
        CompiledJob compiled = PrintCompiler.compile(body, device);
        PrintJob job = jobs.create(device.name(), compiled);
        try {
            queue(device.name()).submit(job);
        } catch (QueueRejectedException e) {
            // The record exists but will never print, so settle it rather than leaving a
            // permanently QUEUED job visible at /jobs/<id>.
            job.cancel();
            throw e;
        }
        return job;
    }

    /**
     * Returns the queue for a device.
     *
     * @param deviceName the configured device name
     * @throws IllegalArgumentException if no such device is configured
     */
    public PrintQueue queue(String deviceName) {
        PrintQueue queue = queues.get(deviceName);
        if (queue == null) {
            throw new IllegalArgumentException("No queue for device " + deviceName);
        }
        return queue;
    }

    /** Returns the queue for a device, or empty if there is none. */
    public Optional<PrintQueue> findQueue(String deviceName) {
        return Optional.ofNullable(queues.get(deviceName));
    }

    /** Returns the job store. */
    public JobStore jobs() {
        return jobs;
    }

    /** Returns the resolved configuration this service was built from. */
    public ResolvedConfig config() {
        return config;
    }

    /** Removes job records that have outlived their retention period. */
    public void evictExpiredJobs() {
        jobs.evictExpired();
    }

    /**
     * Stops every queue, cancelling work that has not started.
     *
     * @param grace how long to wait for each in-flight job
     */
    public void shutdown(Duration grace) {
        queues.values().forEach(queue -> queue.shutdown(grace));
        logger.info("Print queues stopped");
    }
}
