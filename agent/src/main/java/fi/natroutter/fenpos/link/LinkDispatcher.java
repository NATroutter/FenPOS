package fi.natroutter.fenpos.link;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.AgentSettings;
import fi.natroutter.fenpos.Diagnostics;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.markup.ImageResolver;
import fi.natroutter.fenpos.print.CompiledJob;
import fi.natroutter.fenpos.print.JobListener;
import fi.natroutter.fenpos.print.JobSettings;
import fi.natroutter.fenpos.print.PrintCompiler;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintImages;
import fi.natroutter.fenpos.print.PrintQueue;
import fi.natroutter.fenpos.print.PrintRequestException;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.print.QueueRejectedException;
import fi.natroutter.fenpos.print.TestPage;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import fi.natroutter.fenpos.serial.PrinterPort;
import fi.natroutter.fenpos.serial.PrinterWriteException;
import fi.natroutter.fenpos.serial.SerialHandler;
import fi.natroutter.fenpos.util.Text;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Acts on what the server sends, and reports back what happened.
 * <p>
 * <strong>The agent does not trust the server.</strong> That sounds backwards until you consider
 * what a compromised server could otherwise do: it holds every agent's credential path and
 * speaks to hardware in premises it has never seen. So every dispatch is re-checked against this
 * agent's own device set and its own queue depth, a job it cannot render is refused rather than
 * partially printed, and a repeated job identifier prints nothing. None of these checks assume
 * the server did its own.
 */
public class LinkDispatcher implements Consumer<Frames.ServerFrame> {

    /** Reported when a dispatch names a device this agent does not have. */
    private static final String UNKNOWN_DEVICE = "unknown_device";

    /** Reported when a dispatch carries something this agent cannot render. */
    private static final String UNRENDERABLE = "invalid_job";

    /**
     * Reported for any job this agent accepted and then could not print.
     * <p>
     * One code rather than several because the distinctions that matter — the queue was full,
     * the port was closed, the write timed out — are already in the message, and a code the
     * server does not branch on is only useful for grouping.
     */
    private static final String PRINT_FAILED = "print_failed";

    private final DeviceRegistry devices;
    private final PrintService printing;
    private final DeviceConnectionManager connections;
    private final ConfigListener applyConfig;
    private final FoxLogger logger;

    /**
     * Adopts a device set, the job settings and the agent's own timing settings the server
     * pushed, together.
     * <p>
     * One method taking all three rather than separate callbacks, because they all arrive in the
     * same {@code config.sync} frame and the receiving side must apply them as a single update —
     * the job and agent settings only make sense read alongside the devices they now govern.
     */
    @FunctionalInterface
    public interface ConfigListener {

        /**
         * @param wire  the devices as the server described them
         * @param jobs  retention and shutdown settings as the server has them configured
         * @param agent status, eviction and queue-poll timing as the server has them configured
         */
        void accept(List<Frames.DeviceConfig> wire, JobSettings jobs, AgentSettings agent);
    }

    /**
     * Jobs this agent accepted from the server and has not yet finished.
     * <p>
     * Only these are reported. A job printed from the console has an identifier the server never
     * issued, and reporting it would make the server log a warning for a job it has no record
     * of. Entries are removed when the job reaches a terminal state, so the set stays the size
     * of the work actually outstanding.
     */
    private final Set<String> dispatched = ConcurrentHashMap.newKeySet();

    private volatile FrameSender sender = FrameSender.NONE;

    /**
     * What to do when the server's welcome cannot be accepted. Set once, immediately after the
     * link exists, in the same way {@link #attach} supplies the sender.
     */
    private volatile Runnable welcomeRefused = () -> {
    };

    /**
     * Writes locally and forwards to the panel. Starts local-only, because the dispatcher exists
     * before the link does and a refusal during that window still belongs in this agent's log.
     */
    private volatile AgentLog log;

    /**
     * @param devices     this agent's device set, consulted for every dispatch
     * @param printing    where accepted jobs are queued
     * @param connections the serial layer, for opening and closing ports
     * @param applyConfig adopts a device set and job settings the server pushed
     * @param logger      where activity is reported
     */
    public LinkDispatcher(DeviceRegistry devices,
                          PrintService printing,
                          DeviceConnectionManager connections,
                          ConfigListener applyConfig,
                          FoxLogger logger) {
        this.devices = Objects.requireNonNull(devices, "devices");
        this.printing = Objects.requireNonNull(printing, "printing");
        this.connections = Objects.requireNonNull(connections, "connections");
        this.applyConfig = Objects.requireNonNull(applyConfig, "applyConfig");
        this.logger = Objects.requireNonNull(logger, "logger");
        this.log = new AgentLog(logger, FrameSender.NONE);
    }

    /**
     * Supplies the link to report on, and starts reporting.
     * <p>
     * Separate from construction because the two refer to each other: the link needs this to
     * handle frames, and this needs the link to answer them. Set once, immediately after both
     * exist.
     *
     * @param sender the connection to report over
     */
    public void attach(FrameSender sender) {
        this.sender = Objects.requireNonNull(sender, "sender");
        this.log = new AgentLog(logger, sender);
        printing.jobs().listener(reporter());
    }

    /**
     * Registers what to do when the server speaks a protocol this agent does not.
     *
     * <p>Stopping the link is the caller's decision to make, not this class's: it holds no socket.
     *
     * @param handler runs once per refused welcome
     */
    public void onWelcomeRefused(Runnable handler) {
        this.welcomeRefused = Objects.requireNonNull(handler, "handler");
    }

    @Override
    public void accept(Frames.ServerFrame frame) {
        switch (frame) {
            case Frames.Welcome welcome -> onWelcome(welcome);
            case Frames.ConfigSync sync -> onConfigSync(sync);
            case Frames.JobDispatch dispatch -> onDispatch(dispatch.job());
            case Frames.JobCancel cancel -> onCancel(cancel);
            case Frames.RawWrite raw -> onRawWrite(raw);
            case Frames.PortsScan scan -> onPortsScan(scan);
            case Frames.DeviceCommand command -> onCommand(command);
        }
    }

    private void onWelcome(Frames.Welcome welcome) {
        if (welcome.protocolVersion() != Frames.PROTOCOL_VERSION) {
            // Stopped rather than logged. A newer server's next dispatch may carry a directive
            // this agent refuses, and failing receipt by receipt is a worse way to find that out
            // than one refusal at the handshake, which is what the version exists to produce.
            logger.error("This server speaks link protocol " + welcome.protocolVersion()
                    + "; this agent speaks " + Frames.PROTOCOL_VERSION + ". Update the agent. "
                    + "The link will not reconnect until it is restarted against a server it "
                    + "can speak to.");
            welcomeRefused.run();
            return;
        }
        logger.info("Server welcomed this agent as '" + welcome.agentName() + "'");
    }

    /**
     * Adopts a configuration snapshot.
     *
     * <p>The images are taken first, so that a device this agent is about to start printing on
     * cannot be handed a job for a raster the registry has not adopted yet. Both are wholesale
     * replacements — the frame is a snapshot rather than a delta — and the rasters go straight to
     * the registry rather than through {@code applyConfig}, because nothing else has to react to
     * them: adopting devices reopens ports and rebuilds queues, while adopting images is a map
     * swap.
     */
    private void onConfigSync(Frames.ConfigSync sync) {
        devices.applyRasters(sync.assets());
        applyConfig.accept(sync.devices(), sync.jobs(), sync.agent());
        reportStatus();
    }

    /**
     * Prints a job the server dispatched, or reports why it could not.
     * <p>
     * Every refusal is reported. A job that is silently dropped leaves the panel showing
     * {@code QUEUED} forever, which is the single most confusing state this system can produce —
     * it looks like a slow printer rather than a job that will never print.
     */
    private void onDispatch(Frames.CompiledJob job) {
        Optional<Device> target = devices.device(job.device());
        if (target.isEmpty()) {
            log.warn("Refused job " + job.jobId() + ": no device named '" + job.device() + "'", null);
            report(job.jobId(), JobState.FAILED, null, null, UNKNOWN_DEVICE,
                    "This agent has no device named '" + job.device() + "'");
            return;
        }
        Device device = target.get();

        CompiledJob compiled;
        try {
            compiled = IrRenderer.render(job, device, devices);
        } catch (ProtocolException e) {
            log.warn("Refused job " + job.jobId() + ": " + e.getMessage(), job.device());
            report(job.jobId(), JobState.FAILED, null, null, UNRENDERABLE, e.getMessage());
            return;
        } catch (RuntimeException e) {
            // Everything a renderer can throw that nobody planned for: an UncheckedIOException out
            // of the byte stream, an IllegalArgumentException from inside escpos-coffee, a
            // NullPointerException from a bug here. These used to escape to LinkClient's top-level
            // frame handler, which logs and carries on — leaving the panel showing QUEUED forever,
            // which the comment above this method already calls the most confusing state this
            // system produces. The reason reported is deliberately generic: an internal exception
            // message is not written for whoever wrote the markup, and the stack that explains it
            // belongs in this agent's log rather than in a job row on someone's screen.
            logger.error("Could not render job " + job.jobId() + " for device '" + job.device() + "': "
                    + Diagnostics.describe(e));
            log.error("Job " + job.jobId() + " failed while being rendered; see the agent log", job.device());
            report(job.jobId(), JobState.FAILED, null, null, UNRENDERABLE,
                    "This agent could not render that job.");
            return;
        }

        // Registered before submission so that a state change fired by the queue the instant it
        // accepts the job is already recognised as reportable.
        dispatched.add(job.jobId());

        try {
            Optional<PrintJob> accepted = printing.accept(device, job.jobId(), compiled);
            if (accepted.isEmpty()) {
                // Already seen. The server is retrying something this agent has, so there is
                // nothing to print and nothing to correct.
                logger.info("Ignored a repeat dispatch of job " + job.jobId());
                return;
            }
            log.info("Accepted job " + job.jobId() + " (" + compiled.lines() + " lines, "
                    + compiled.bytes() + " bytes)", device.name());
        } catch (QueueRejectedException e) {
            // The job was failed by the print service, which fires the listener, so the server
            // has already been told. Only the local log is left to write.
            log.warn("Job " + job.jobId() + " refused: " + e.getMessage(), device.name());
        } catch (IllegalArgumentException e) {
            // The device is in the registry but has no queue, which means its port never opened.
            dispatched.remove(job.jobId());
            log.warn("Refused job " + job.jobId() + ": " + device.name() + " has no queue", device.name());
            report(job.jobId(), JobState.FAILED, null, null, UNKNOWN_DEVICE,
                    "Device '" + device.name() + "' is not usable on this agent");
        }
    }

    /**
     * Withdraws a job the server asked to cancel.
     *
     * <p>Silent when the job is unknown or has already started. Both are ordinary races rather
     * than faults: the server sends this without knowing whether the paper has moved, and the
     * job update the queue emits is the authoritative answer either way.
     */
    private void onCancel(Frames.JobCancel cancel) {
        printing.jobs().find(cancel.jobId()).ifPresentOrElse(
                job -> {
                    if (job.cancel()) {
                        logger.info("Cancelled job " + cancel.jobId() + " on request");
                    } else {
                        logger.info("Job " + cancel.jobId() + " could not be cancelled; it is "
                                + job.state());
                    }
                },
                () -> logger.warn("Asked to cancel unknown job " + cancel.jobId()));
    }

    // -------------------------------------------------------------------------
    // Device control
    // -------------------------------------------------------------------------

    /**
     * Answers a request for this machine's serial ports.
     * <p>
     * The panel's port picker is populated from this rather than from anything typed, because
     * the operator configuring a printer is usually not sitting at the machine it is plugged
     * into, and a mistyped port name fails as a device that simply never connects.
     */
    private void onPortsScan(Frames.PortsScan scan) {
        List<Frames.SerialPort> ports = new ArrayList<>();
        for (com.fazecast.jSerialComm.SerialPort port : SerialHandler.availablePorts()) {
            ports.add(new Frames.SerialPort(
                    text(port.getSystemPortName()),
                    text(port.getPortDescription()),
                    port.getVendorID(),
                    port.getProductID(),
                    text(port.getSerialNumber())));
        }

        logger.info("Reported " + ports.size() + " serial port(s) to the server");
        sender.send(new Frames.PortsResult(scan.requestId(), ports));
    }

    /**
     * Acts on one printer.
     * <p>
     * Every outcome is answered, including the failures. An operator who pressed Connect and got
     * nothing back cannot tell a port that will not open from a link that dropped the request,
     * and those need different actions from them.
     */
    private void onCommand(Frames.DeviceCommand command) {
        String name = command.device();

        if (devices.device(name).isEmpty()) {
            answer(command, false, "This agent has no device named '" + name + "'");
            return;
        }

        try {
            switch (command.type()) {
                case "device.connect" -> connect(command, name);
                case "device.disconnect" -> disconnect(command, name);
                case "device.pause" -> {
                    queue(name).pause();
                    answer(command, true, "Printing paused");
                }
                case "device.resume" -> {
                    queue(name).resume();
                    answer(command, true, "Printing resumed");
                }
                case "device.clearQueue" -> {
                    int cancelled = queue(name).clear();
                    answer(command, true, "Cancelled " + cancelled + " queued job(s)");
                }
                case "device.test" -> test(command, name);
                default -> answer(command, false, "Unknown command '" + command.type() + "'");
            }
        } catch (IllegalArgumentException e) {
            // The device is configured but has no queue, which means its port never opened.
            answer(command, false, "Device '" + name + "' is not usable on this agent");
        } finally {
            reportStatus();
        }
    }

    private void connect(Frames.DeviceCommand command, String name) {
        SerialHandler handler = connections.handler(name).orElse(null);
        if (handler == null) {
            answer(command, false, "Device '" + name + "' has no serial handler");
            return;
        }

        handler.connect();
        if (handler.status().isUsable()) {
            answer(command, true, "Connected to " + handler.serial().port());
            return;
        }

        // The handler's status carries the diagnosis the operator needs — no such port, or in
        // use by another process — so it is reported rather than a generic failure.
        handler.startReconnectLoop();
        answer(command, false, handler.status().getLabel() + " on " + handler.serial().port());
    }

    private void disconnect(Frames.DeviceCommand command, String name) {
        SerialHandler handler = connections.handler(name).orElse(null);
        if (handler == null) {
            answer(command, false, "Device '" + name + "' has no serial handler");
            return;
        }
        handler.disconnect();
        answer(command, true, "Disconnected");
    }

    /**
     * Prints a test page composed here rather than by the server.
     * <p>
     * The page exists to prove what this printer does with the settings this agent holds.
     * Compiling it from the server's copy would still pass if the two had diverged, which is
     * exactly the fault someone reaches for a test page to find.
     * <p>
     * Composed here, but recorded there: a command carrying a job id names the row the server
     * created for this page, and the page is queued under that id exactly as a dispatched job
     * is, so the same state reports reach the panel and the page shows in the Jobs tab with its
     * lines and bytes. A command with no id — an older server — prints an unrecorded page as
     * before.
     */
    private void test(Frames.DeviceCommand command, String name) {
        Device device = devices.device(name).orElseThrow();
        ImageResolver images = PrintImages.forDevice(device, devices);
        String body = TestPage.bodyFor(device, images);
        String jobId = command.jobId();

        try {
            if (jobId == null) {
                PrintJob job = printing.submit(device, body);
                answer(command, true, "Queued test page " + job.id());
                return;
            }

            CompiledJob compiled = PrintCompiler.compile(body, device, images);
            // Registered before submission, as in onDispatch: the queue can fire a state change the
            // instant it accepts the job, and that change must already count as reportable.
            dispatched.add(jobId);
            try {
                if (printing.accept(device, jobId, compiled).isEmpty()) {
                    answer(command, true, "Test page " + jobId + " was already queued");
                    return;
                }
            } catch (QueueRejectedException e) {
                // Failed by the print service through the listener, so the server has been told;
                // only the command's answer is left.
                answer(command, false, e.getMessage());
                return;
            }
            answer(command, true, "Queued test page " + jobId + " (" + compiled.lines() + " lines, "
                    + compiled.bytes() + " bytes)");
        } catch (PrintRequestException e) {
            // The page never became a job here, so nothing will report it; the row the server holds
            // must still be settled, or it sits QUEUED forever.
            if (jobId != null) {
                dispatched.remove(jobId);
                report(jobId, JobState.FAILED, null, null, UNRENDERABLE, e.getMessage());
            }
            answer(command, false, e.getMessage());
        } catch (QueueRejectedException e) {
            answer(command, false, e.getMessage());
        }
    }

    private PrintQueue queue(String name) {
        return printing.queue(name);
    }

    /**
     * Writes bytes to a printer exactly as given.
     * <p>
     * Every one is logged and forwarded, including the ones that succeed. This is the only frame
     * that hands arbitrary bytes to hardware, so the agent keeps its own record of what it was
     * asked to write — which is the last thing standing if the server is ever the problem.
     * <p>
     * The write goes straight to the port rather than through the queue. That is the point of the
     * tool: someone is debugging a printer that is not behaving, and making their bytes wait
     * behind a stuck job would defeat the exercise.
     */
    private void onRawWrite(Frames.RawWrite raw) {
        if (devices.device(raw.device()).isEmpty()) {
            reply(raw.requestId(), false,
                    "This agent has no device named '" + raw.device() + "'", raw.device());
            return;
        }

        byte[] payload;
        try {
            payload = Base64.getDecoder().decode(raw.bytes());
        } catch (IllegalArgumentException e) {
            reply(raw.requestId(), false, "Payload was not valid base64", raw.device());
            return;
        }

        PrinterPort port = connections.port(raw.device()).orElse(null);
        if (port == null) {
            reply(raw.requestId(), false, "Device has no serial handler", raw.device());
            return;
        }

        try {
            port.write(payload);
            // Logged at warning level even on success. This is not an error, but it is the one
            // thing in the system worth noticing in a log nobody was reading closely.
            log.warn("Raw write of " + payload.length + " bytes", raw.device());
            reply(raw.requestId(), true, "Wrote " + payload.length + " bytes", raw.device());
        } catch (PrinterWriteException e) {
            reply(raw.requestId(), false, e.getMessage(), raw.device());
        } finally {
            reportStatus();
        }
    }

    /** Sends an answer for a request that is not a device command. */
    private void reply(String requestId, boolean ok, String message, String device) {
        if (!ok) {
            log.warn(message, device);
        }
        sender.send(new Frames.CommandResult(requestId, ok, message));
    }

    /** Sends the answer to a command, and logs what it was. */
    private void answer(Frames.DeviceCommand command, boolean ok, String message) {
        if (ok) {
            log.info(command.type() + ": " + message, command.device());
        } else {
            log.warn(command.type() + " failed: " + message, command.device());
        }
        sender.send(new Frames.CommandResult(command.requestId(), ok, message));
    }

    /**
     * Pushes the observed state of every device.
     * <p>
     * Pushed rather than polled, and pushed after anything that could have changed it. The
     * panel's picture of a printer is only ever as fresh as the last report, so a change that
     * did not trigger one shows as a stale chip that nobody can explain.
     */
    public void reportStatus() {
        List<Frames.DeviceStatus> statuses = new ArrayList<>();
        for (Device device : devices.all()) {
            Optional<PrintQueue> queue = printing.findQueue(device.name());
            statuses.add(new Frames.DeviceStatus(
                    device.name(),
                    connections.status(device.name()),
                    queue.map(PrintQueue::isPaused).orElse(device.paused()),
                    queue.map(PrintQueue::depth).orElse(0)));
        }
        sender.send(new Frames.StatusReport(statuses));
    }

    /** Normalises an operating system string, which may be null, and makes it safe to log. */
    private static String text(String value) {
        return Text.safe(value);
    }

    /**
     * Builds the listener that turns local state changes into {@code job.update} frames.
     * <p>
     * Reporting is best effort by design. If the link is down when a job finishes, the update is
     * lost and the server reconciles when the agent reconnects — which is the right trade for a
     * printer that must keep printing through an outage rather than block on telling anyone. The
     * loss itself is not silent: {@code LinkClient.send} logs every frame it could not hand over.
     * <p>
     * Failures here are caught and logged rather than allowed out. {@code PrintJob} swallows a
     * throwing listener to protect the queue worker that called it, and a swallow is only safe
     * when the thing being swallowed has already been written down somewhere.
     */
    private JobListener reporter() {
        return (job, state) -> {
            try {
                if (!dispatched.contains(job.id())) {
                    // A job this agent printed for itself — a console test page, say. The server
                    // never asked for it and has no row to update, so there is nothing to send.
                    Diagnostics.debug(logger, "Not reporting job " + job.id() + " reaching " + state
                            + ": the server did not dispatch it");
                    return;
                }
                if (state.isTerminal()) {
                    dispatched.remove(job.id());
                }
                report(job.id(), state, job.lines(), job.bytes(), errorCode(state),
                        job.failureReason());

                // The queue depth just changed, and the panel's picture of a printer is only ever
                // as fresh as the last report. Sending one here is what keeps a draining queue
                // visibly draining rather than jumping when the slow timer next fires.
                reportStatus();
            } catch (RuntimeException e) {
                logger.error("Could not report job " + job.id() + " reaching " + state + ": "
                        + Diagnostics.describe(e));
            }
        };
    }

    /** Returns the stable code for a state, or null for states that are not failures. */
    private static String errorCode(JobState state) {
        return state == JobState.FAILED ? PRINT_FAILED : null;
    }

    /** Sends one job update, if the link is up. */
    private void report(String jobId,
                        JobState state,
                        Integer lines,
                        Integer bytes,
                        String errorCode,
                        String errorMessage) {
        sender.send(new Frames.JobUpdate(
                jobId,
                state,
                Instant.now().truncatedTo(ChronoUnit.MILLIS).toString(),
                lines,
                bytes,
                errorMessage == null ? null : errorCode,
                errorMessage));
    }
}
