package fi.natroutter.fenpos.print;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import fi.natroutter.fenpos.serial.PrinterPort;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Ties the compile pipeline, the job store and the per-device queues together.
 * <p>
 * Exists so the console and the link dispatcher come onto the same behaviour rather than each
 * assembling the pieces themselves; printing from the console and printing from a job the
 * server dispatched must not be able to drift apart.
 */
public class PrintService {

    private final DeviceRegistry devices;
    private final JobSettings settings;
    private final JobStore jobs;
    private final PortLookup ports;
    private final Map<String, PrintQueue> queues = new LinkedHashMap<>();
    private final FoxLogger logger;

    /** Whether {@link #start()} has run, and therefore whether a new queue starts on arrival. */
    private boolean started;

    /**
     * Supplies the port for a device.
     * <p>
     * Taken as a function rather than as a {@link DeviceConnectionManager} so the service
     * can be assembled over fake ports. That is what allows the print path to be exercised
     * end to end — job in, job record out — without a serial device attached.
     */
    @FunctionalInterface
    public interface PortLookup {

        /**
         * @param deviceName the device name
         * @return the port, or empty if no such device exists
         */
        Optional<PrinterPort> port(String deviceName);
    }

    /**
     * Creates a service holding no queues. Queues appear only once {@link #applyDevices()}
     * runs against a device set the server has pushed.
     *
     * @param devices  the device set to reconcile against
     * @param settings job retention and shutdown settings
     * @param ports    supplies each device's port
     * @param clock    time source for job timestamps
     * @param logger   logger for job lifecycle messages
     */
    public PrintService(DeviceRegistry devices,
                        JobSettings settings,
                        PortLookup ports,
                        Clock clock,
                        FoxLogger logger) {
        this.devices = Objects.requireNonNull(devices, "devices");
        this.settings = Objects.requireNonNull(settings, "settings");
        this.ports = Objects.requireNonNull(ports, "ports");
        this.logger = Objects.requireNonNull(logger, "logger");
        this.jobs = new JobStore(settings, Objects.requireNonNull(clock, "clock"));
    }

    /** Starts every queue that exists, and marks later arrivals to start on creation. */
    public synchronized void start() {
        started = true;
        queues.values().forEach(PrintQueue::start);
        logger.info("Print queues started for " + queues.size() + " device(s)");
    }

    /**
     * Brings the queues into line with the registry.
     * <p>
     * Must run after {@link DeviceConnectionManager#applyDevices()}, because a queue is built
     * around the port that manager owns. A queue whose device is unchanged is left alone, so a
     * {@code config.sync} that changes nothing does not discard work already waiting to print.
     * <p>
     * Removing a device drains its queue within the shutdown grace rather than dropping it:
     * the operator deleted a printer from the panel, which says nothing about the receipt
     * already halfway through it.
     */
    public synchronized void applyDevices() {
        List<Device> current = List.copyOf(devices.all());
        List<String> wanted = current.stream().map(Device::name).toList();

        List<String> gone = new ArrayList<>(queues.keySet());
        gone.removeAll(wanted);
        for (String name : gone) {
            queues.remove(name).shutdown(settings.shutdownGrace());
        }

        for (Device device : current) {
            PrinterPort port = ports.port(device.name()).orElse(null);
            if (port == null) {
                // The serial layer reconciles first, so this means the two disagree about
                // what exists — a bug rather than a missing printer, and one that would
                // otherwise surface much later as a job that never prints.
                logger.error("No port registered for device " + device.name()
                        + "; it will not accept jobs");
                continue;
            }

            PrintQueue existing = queues.get(device.name());
            if (existing == null
                    || existing.port() != port
                    || existing.capacity() != device.limits().maxQueueDepth()) {
                if (existing != null) {
                    existing.shutdown(settings.shutdownGrace());
                }
                queues.put(device.name(), build(device, port));
            }
            applyPause(queues.get(device.name()), device.paused());
        }
    }

    /** Creates a queue for a device, started if the service is already running. */
    private PrintQueue build(Device device, PrinterPort port) {
        PrintQueue queue = new PrintQueue(port, device.limits().maxQueueDepth(), logger);
        if (started) {
            queue.start();
        }
        return queue;
    }

    /** Aligns a queue with the paused flag the panel set, without logging a no-op change. */
    private static void applyPause(PrintQueue queue, boolean paused) {
        if (queue.isPaused() == paused) {
            return;
        }
        if (paused) {
            queue.pause();
        } else {
            queue.resume();
        }
    }

    /**
     * Compiles a request body and queues it for printing.
     *
     * @param device the target device
     * @param body   the raw JSON request body
     * @return the queued job
     * @throws PrintRequestException  if the request cannot be printed as given
     * @throws QueueRejectedException if the device cannot accept work right now
     */
    public PrintJob submit(Device device, String body)
            throws PrintRequestException, QueueRejectedException {
        CompiledJob compiled = PrintCompiler.compile(
                body, device, SyncedImages.forDevice(device, devices));
        PrintJob job = jobs.create(device.name(), compiled);
        try {
            queue(device.name()).submit(job);
        } catch (QueueRejectedException e) {
            // The record exists but will never print, so settle it rather than leaving a
            // permanently QUEUED job visible to the panel.
            job.cancel();
            throw e;
        }
        return job;
    }

    /**
     * Queues a job the server already compiled.
     * <p>
     * The identifier comes from the server rather than being generated here, which is what lets
     * both sides talk about the same job and what makes the duplicate check possible. A dispatch
     * can arrive twice — a retry after a close the server did not see acknowledged, or a spool
     * replayed on reconnect — and printing a receipt twice costs whoever is holding the paper.
     * <p>
     * A queue that refuses the job fails it rather than cancelling it. Cancelled means an
     * operator withdrew it; this job was accepted and then could not be taken, which the panel
     * should show as a failure with the reason attached.
     *
     * @param device   the target device
     * @param jobId    the server's identifier for this job
     * @param compiled the rendered payload
     * @return the queued job, or empty when this identifier has already been seen
     * @throws QueueRejectedException if the device cannot accept work right now
     */
    public Optional<PrintJob> accept(Device device, String jobId, CompiledJob compiled)
            throws QueueRejectedException {
        Optional<PrintJob> adopted = jobs.adopt(jobId, device.name(), compiled);
        if (adopted.isEmpty()) {
            return Optional.empty();
        }

        PrintJob job = adopted.get();
        try {
            queue(device.name()).submit(job);
        } catch (QueueRejectedException e) {
            job.fail(e.getMessage());
            throw e;
        }
        return adopted;
    }

    /** Returns the device set this service prints for. */
    public DeviceRegistry devices() {
        return devices;
    }

    /**
     * Returns the queue for a device.
     *
     * @param deviceName the device name
     * @throws IllegalArgumentException if no such device exists
     */
    public synchronized PrintQueue queue(String deviceName) {
        PrintQueue queue = queues.get(deviceName);
        if (queue == null) {
            throw new IllegalArgumentException("No queue for device " + deviceName);
        }
        return queue;
    }

    /** Returns the queue for a device, or empty if there is none. */
    public synchronized Optional<PrintQueue> findQueue(String deviceName) {
        return Optional.ofNullable(queues.get(deviceName));
    }

    /** Returns the job store. */
    public JobStore jobs() {
        return jobs;
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
    public synchronized void shutdown(Duration grace) {
        queues.values().forEach(queue -> queue.shutdown(grace));
        logger.info("Print queues stopped");
    }
}
