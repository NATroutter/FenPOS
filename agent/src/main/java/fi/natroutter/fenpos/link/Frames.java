package fi.natroutter.fenpos.link;

import fi.natroutter.fenpos.AgentSettings;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.ConnectionStatus;
import fi.natroutter.fenpos.enums.CutMode;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.LogLevel;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.print.JobSettings;

import java.util.List;

/**
 * The wire contract between the agent and the FenPOS server.
 *
 * <p>Mirrors {@code fenpos/lib/link/protocol.ts}, which is the definition of record. Changing
 * a shape on one side without the other produces a job the server accepts and the agent then
 * cannot parse — a print that is acknowledged and never appears. The two must move together.
 *
 * <p>Frames are grouped here rather than spread across a package because they are one
 * contract, and reading them together is how a reader checks them against the server.
 *
 * <p>These records are deliberately separate from the render model in
 * {@code fi.natroutter.fenpos.markup.model}. That model carries a source column used to point
 * at the exact character a codepage rejected, which is meaningful only while parsing markup —
 * a concern that now lives on the server. Keeping the wire types distinct means neither side
 * grows a field that exists only to satisfy the other.
 */
public final class Frames {

    /**
     * Protocol version this agent implements. Must match PROTOCOL_VERSION on the server.
     *
     * <p>Bumped 1 -&gt; 2 for the {@code QR}, {@code BARCODE}, {@code PDF417} and {@code DRAWER}
     * directives. {@link FrameCodec#readDirective} refuses a directive type it does not know, so
     * an older agent handed one of these would fail the job rather than print it incomplete. The
     * version is what turns that into a refusal to connect at all, which an operator sees once
     * instead of discovering per receipt.
     *
     * <p>Bumped 2 -&gt; 3 for the {@code IMAGE} directive, the {@code config.sync} asset payload,
     * and making {@code columns} required on the {@code PDF417} directive — a version-2 agent
     * would not recognise the new directive or payload, and would silently fall back to
     * printer-decided layout on a version-2 PDF417 block that omits {@code columns}, which is
     * exactly the ambiguity the field was added to remove.
     */
    public static final int PROTOCOL_VERSION = 3;

    private Frames() {
    }

    /** A frame the agent sends to the server. */
    public sealed interface AgentFrame
            permits Hello, JobUpdate, PortsResult, CommandResult, StatusReport, LogLine {

        /** @return the {@code type} discriminator written to the wire */
        String type();
    }

    /** A frame the server sends to the agent. */
    public sealed interface ServerFrame
            permits Welcome, ConfigSync, JobDispatch, JobCancel, PortsScan, DeviceCommand, RawWrite {

        /** @return the {@code type} discriminator read from the wire */
        String type();
    }

    /**
     * The agent's opening frame, sent once per connection.
     *
     * <p>Carries no credential: the token is presented in the upgrade request, so a connection
     * that reaches this point is already authenticated. What it carries is the agent's account
     * of itself, which the server records for display.
     *
     * @param protocolVersion the protocol this agent speaks
     * @param agentVersion    the agent's own software version
     * @param platform        operating system and architecture
     * @param hostname        the host this agent runs on
     * @param outstanding     identifiers of the jobs this agent accepted and has not finished
     *                        reporting on, or null when it has no answer to give. Null is not
     *                        "none": it means the question cannot be answered, and the server
     *                        settles nothing on the strength of it. That is also what an agent
     *                        built before this field existed sends, so the two are indistinguishable
     *                        and the server treats them alike.
     */
    public record Hello(int protocolVersion,
                        String agentVersion,
                        String platform,
                        String hostname,
                        List<String> outstanding) implements AgentFrame {

        public Hello {
            outstanding = outstanding == null ? null : List.copyOf(outstanding);
        }

        @Override
        public String type() {
            return "hello";
        }
    }

    /**
     * Reports that a job changed state.
     *
     * @param jobId        the job this concerns
     * @param status       the state reached
     * @param at           when it was reached, ISO-8601 in UTC
     * @param lines        printed lines, or null before the job has rendered
     * @param bytes        rendered ESC/POS byte count, or null before the job has rendered
     * @param errorCode    stable failure code, or null when the job did not fail
     * @param errorMessage human-readable failure detail, or null when the job did not fail
     */
    public record JobUpdate(
            String jobId,
            JobState status,
            String at,
            Integer lines,
            Integer bytes,
            String errorCode,
            String errorMessage) implements AgentFrame {

        @Override
        public String type() {
            return "job.update";
        }

        /**
         * Builds an update carrying no metrics, for a state change that has none.
         *
         * @param jobId  the job this concerns
         * @param status the state reached
         * @param at     when it was reached, ISO-8601 in UTC
         * @return the update
         */
        public static JobUpdate of(String jobId, JobState status, String at) {
            return new JobUpdate(jobId, status, at, null, null, null, null);
        }
    }

    /**
     * The server's answer to {@link Hello}.
     *
     * @param protocolVersion the protocol the server speaks
     * @param agentId         this agent's server-side identifier
     * @param agentName       this agent's name, as shown in the panel
     * @param serverTime      the server's clock, ISO-8601 in UTC
     */
    public record Welcome(int protocolVersion, String agentId, String agentName, String serverTime)
            implements ServerFrame {

        @Override
        public String type() {
            return "welcome";
        }
    }

    /**
     * The authoritative device set, the images behind it, the job settings that govern how long
     * its results are kept, and the agent's own operational timing.
     *
     * <p>Always a whole snapshot, never a delta. That makes it idempotent, so an agent that
     * missed changes while disconnected converges on reconnect without either side tracking
     * what the other has seen.
     *
     * <p>The images travel here rather than inside each job that prints one. They change rarely
     * and the agent must hold them before a job arrives, which is the same argument that puts
     * the device set here — and a logo repeated on every receipt of the day then crosses the
     * link once. The cost of the snapshot being whole is that they are re-sent on every
     * reconnect rather than only when they change.
     *
     * <p>{@code agent} carries the status report interval, the job eviction sweep interval and
     * the print queue's idle poll interval — three values that used to be fixed constants and
     * are now pushed the same way {@code jobs} is, for the same reason: re-sending them on every
     * reconnect costs nothing worth tracking a delta to avoid.
     *
     * @param devices every device configured behind this agent
     * @param assets  one raster per stored image per distinct paper width behind this agent
     * @param jobs    retention and shutdown settings; never null — {@link JobSettings#DEFAULTS}
     *                when the server omitted them, which is what an older server does
     * @param agent   status, eviction and queue-poll timing; never null —
     *                {@link AgentSettings#DEFAULTS} when the server omitted them, which is what
     *                an older server does
     */
    public record ConfigSync(
            List<DeviceConfig> devices, List<AssetRaster> assets, JobSettings jobs, AgentSettings agent)
            implements ServerFrame {

        public ConfigSync {
            devices = List.copyOf(devices);
            assets = List.copyOf(assets);
            jobs = jobs == null ? JobSettings.DEFAULTS : jobs;
            agent = agent == null ? AgentSettings.DEFAULTS : agent;
        }

        @Override
        public String type() {
            return "config.sync";
        }
    }

    /**
     * A compiled job to print.
     *
     * @param job the job, already validated and wrapped by the server
     */
    public record JobDispatch(CompiledJob job) implements ServerFrame {

        @Override
        public String type() {
            return "job.dispatch";
        }
    }

    /**
     * A request to withdraw a job that has not started printing.
     *
     * <p>A request rather than an instruction. Only this agent knows whether the job is still
     * waiting or already halfway through the paper, so the outcome goes back as an ordinary job
     * update rather than being assumed by the server.
     *
     * @param jobId the job to withdraw
     */
    public record JobCancel(String jobId) implements ServerFrame {

        @Override
        public String type() {
            return "job.cancel";
        }
    }

    /**
     * A request for this machine's serial ports.
     *
     * @param requestId correlates the answer with this request
     */
    public record PortsScan(String requestId) implements ServerFrame {

        @Override
        public String type() {
            return "ports.scan";
        }
    }

    /**
     * Bytes to write to a printer unmodified.
     *
     * <p>The one frame that hands arbitrary bytes to hardware. The agent caps the size, refuses it
     * for a device it does not have, and logs every one — not because the server is expected to
     * misuse it, but because this is the frame where a compromised server would do the most damage
     * and the only defence left is that the agent has its own record of what it was asked to do.
     *
     * <p><strong>A raw write ignores Pause, deliberately.</strong> Everything else refuses a paused
     * device, because a pause means an operator stopped the paper on purpose. This does not, because
     * the reason someone is sending raw bytes is usually that a printer is misbehaving and they have
     * paused it so receipts stop flowing while they work on it. Refusing them then would defeat the
     * exercise. What bounds this instead is a rate limit, in {@code RawWriteLimit}.
     *
     * @param requestId correlates the answer with this request
     * @param device    the device to write to
     * @param bytes     the bytes, base64 encoded
     */
    public record RawWrite(String requestId, String device, String bytes) implements ServerFrame {

        @Override
        public String type() {
            return "raw.write";
        }
    }

    /**
     * An instruction to act on one printer.
     *
     * <p>The action is the frame type rather than a field, so an unknown action fails at the
     * same place an unknown frame does and there is no second vocabulary to keep in step.
     *
     * @param type      which action, one of the {@code device.*} types
     * @param requestId correlates the answer with this request
     * @param device    the device to act on
     * @param jobId     for {@code device.test}, the job the server recorded the page under, so it
     *                  is reported like a dispatched job; null from a server that records none
     */
    public record DeviceCommand(String type, String requestId, String device, String jobId)
            implements ServerFrame {
    }

    /**
     * The answer to a {@link PortsScan}.
     *
     * @param requestId the request this answers
     * @param ports     every serial port the operating system reports
     */
    public record PortsResult(String requestId, List<SerialPort> ports) implements AgentFrame {

        public PortsResult {
            ports = List.copyOf(ports);
        }

        @Override
        public String type() {
            return "ports.result";
        }
    }

    /**
     * The answer to a {@link DeviceCommand}.
     *
     * <p>Carries the agent's own words on failure. "Could not open COM3; it may be in use by
     * another process" is the sentence that tells an operator what to do, and only the machine
     * holding the port can produce it.
     *
     * @param requestId the request this answers
     * @param ok        whether the action succeeded
     * @param message   what happened, or null when there is nothing to add
     */
    public record CommandResult(String requestId, boolean ok, String message)
            implements AgentFrame {

        @Override
        public String type() {
            return "command.result";
        }
    }

    /**
     * The observed state of every device on this agent.
     *
     * <p>Pushed after anything changes and on a slow timer, rather than polled. This is observed
     * state and neither side persists it: a port cannot stay open across a restart, so a stored
     * "connected" would be wrong from the moment either process came back.
     *
     * @param devices one entry per device this agent holds
     */
    public record StatusReport(List<DeviceStatus> devices) implements AgentFrame {

        public StatusReport {
            devices = List.copyOf(devices);
        }

        @Override
        public String type() {
            return "status.report";
        }
    }

    /**
     * Something worth recording, forwarded to the server.
     *
     * <p>Forwarded rather than mirrored: the agent keeps its own local log regardless, and this is
     * the subset an operator watching the panel needs to see. Sent best effort — a line that
     * cannot be delivered is dropped rather than buffered, because a agent whose link is down has
     * more useful things to do with its memory than hold log text.
     *
     * @param level   severity
     * @param message what happened
     * @param device  the device this concerns, or null when it concerns none
     * @param at      the agent's clock, ISO-8601 in UTC
     */
    public record LogLine(LogLevel level, String message, String device, String at)
            implements AgentFrame {

        @Override
        public String type() {
            return "log";
        }
    }

    /**
     * One serial port the operating system reports.
     *
     * <p>Every field is the operating system's own text and is treated as untrusted by the
     * server, which renders it as text and never as markup: a USB device's descriptor strings
     * are chosen by whoever made the device.
     *
     * @param name         port name, such as {@code COM3} or {@code /dev/ttyUSB0}
     * @param description  the operating system's description
     * @param vendorId     USB vendor id, or 0 when not a USB device
     * @param productId    USB product id, or 0 when not a USB device
     * @param serialNumber USB serial number, or empty when the adapter reports none
     */
    public record SerialPort(
            String name,
            String description,
            int vendorId,
            int productId,
            String serialNumber) {
    }

    /**
     * One device's observed state.
     *
     * @param name       the device this concerns
     * @param connection whether its port is open
     * @param paused     whether printing is held
     * @param queueDepth jobs waiting, not counting one being written
     */
    public record DeviceStatus(
            String name,
            ConnectionStatus connection,
            boolean paused,
            int queueDepth) {
    }

    /**
     * A device as the agent needs to know it.
     *
     * <p>Only what is required to open the port and render correctly. The server keeps the
     * rest — grants, limits, job history — because the agent has no decision to make with it.
     *
     * @param name                  device name, unique within this agent
     * @param port                  serial port path
     * @param baudRate              serial speed
     * @param dataBits              bits per character
     * @param stopBits              stop bits
     * @param parity                parity mode
     * @param flowControl           flow control mode
     * @param writeTimeoutMs        how long a write may block before failing
     * @param autoConnect           whether to open the port at startup
     * @param autoReconnect         whether to reopen the port after a failure
     * @param reconnectDelaySeconds pause between reconnection attempts
     * @param columns               printable columns for this paper width
     * @param codepage              character table the printer is set to
     * @param paused                whether the operator has paused this device
     * @param maxQueueDepth         pending jobs beyond which dispatches are refused
     */
    public record DeviceConfig(
            String name,
            String port,
            int baudRate,
            int dataBits,
            int stopBits,
            Parity parity,
            FlowControl flowControl,
            int writeTimeoutMs,
            boolean autoConnect,
            boolean autoReconnect,
            int reconnectDelaySeconds,
            int columns,
            Codepage codepage,
            boolean paused,
            int maxQueueDepth) {
    }

    /**
     * One stored image, already reduced to dots for one paper width.
     *
     * <p><strong>The server owns dithering.</strong> A thermal head has one ink and no greys, so
     * deciding which dots burn is real work with real choices in it, and doing it on the server
     * means the panel's preview and the paper agree — speckle for speckle — because one piece of
     * code made both. It also means this agent needs no image decoder, which is most of why it
     * fits on a Raspberry Pi.
     *
     * <p>Keyed by name and width because that pair is what a job names. An install with an 80mm
     * and a 58mm printer behind one agent receives two entries per image: shrinking a raster
     * already reduced to black and white resamples the dither's own noise, so there is no single
     * width that would have been the right one to send.
     *
     * <p>{@code packed} is one bit per dot, most significant bit first, each row padded to a
     * whole byte, a set bit meaning ink — the layout ESC/POS {@code GS v 0} takes verbatim. The
     * array is copied on the way in; callers must treat what the accessor returns as read-only,
     * since a record cannot defend it further without copying on every print.
     *
     * @param name       the image's name, as markup refers to it
     * @param widthDots  the raster's width in printer dots
     * @param heightDots the raster's height in printer dots
     * @param packed     the dots
     */
    public record AssetRaster(String name, int widthDots, int heightDots, byte[] packed) {

        public AssetRaster {
            packed = packed.clone();
        }
    }

    /**
     * A job compiled to the intermediate representation the agent renders.
     *
     * <p>Markup parsing, limit enforcement, wrapping and codepage validation all happened on
     * the server, which is what lets a bad request be refused synchronously with the exact line
     * and column at fault. By the time a job reaches here it is printable or the hardware is
     * broken.
     *
     * @param jobId    the job's identifier, used to report state and to deduplicate
     * @param device   the device to print on
     * @param linefeed the terminator written after each line
     * @param lines    the lines to print, already wrapped to the device's columns
     */
    public record CompiledJob(String jobId, String device, Linefeed linefeed, List<WireLine> lines) {

        public CompiledJob {
            lines = List.copyOf(lines);
        }
    }

    /**
     * One printed line, as received.
     *
     * @param align      justification, applied to the whole line by ESC/POS
     * @param spans      styled runs of text, possibly empty for a directive-only line
     * @param directives printer actions attached to this line
     */
    public record WireLine(Align align, List<WireSpan> spans, List<WireDirective> directives) {

        public WireLine {
            spans = List.copyOf(spans);
            directives = List.copyOf(directives);
        }
    }

    /**
     * A styled run of text, as received.
     *
     * <p>Styles are fully resolved rather than expressed as a tag stack, so a span can be
     * rendered without tracking state across the line.
     *
     * @param text       the characters to print
     * @param bold       emphasis
     * @param underline  thickness: 0 none, 1 or 2 for the two ESC/POS weights
     * @param invert     white on black
     * @param widthMult  horizontal size multiplier, 1..8
     * @param heightMult vertical size multiplier, 1..8
     * @param font       printer font
     */
    public record WireSpan(
            String text,
            boolean bold,
            int underline,
            boolean invert,
            int widthMult,
            int heightMult,
            Font font) {
    }

    /**
     * A printer action that is not text.
     *
     * <p>Sealed with one record per kind rather than one record carrying every kind's fields.
     * A flat shape would need a nullable field for each variant's arguments, and every reader
     * would then have to know which combinations are real — a QR code with a cut mode is
     * expressible but meaningless. Here the type system carries that knowledge, and the
     * renderer's switch is exhaustive, so a kind added later cannot be silently dropped.
     *
     * <p>The horizontal rule the markup grammar offers is expanded to characters by the
     * server, because only the server knows the device's column count at compile time. It is
     * therefore absent here.
     *
     * <p>None of the symbols carry a printed height. Height is the server's concern: it
     * measures the symbol to charge the job's line budget and to draw the preview. The agent's
     * library computes its own geometry when it draws, so a height on the wire would be a
     * second opinion nothing reads. An image is the exception and is not a counter-example: the
     * height on {@link InlineImage} is not a measurement but part of the picture, because a
     * rectangle of bits cannot be read back into rows without it.
     */
    public sealed interface WireDirective
            permits WireDirective.Cut, WireDirective.Feed, WireDirective.Qr,
                    WireDirective.Barcode, WireDirective.Pdf417, WireDirective.Drawer,
                    WireDirective.StoredImage, WireDirective.InlineImage {

        /**
         * Cuts the paper.
         *
         * @param mode how completely the paper is severed
         */
        record Cut(CutMode mode) implements WireDirective {
        }

        /**
         * Advances the paper.
         *
         * @param lines how many lines to advance
         */
        record Feed(int lines) implements WireDirective {
        }

        /**
         * A QR code.
         *
         * @param content the data to encode
         * @param size    module size in printer dots, 1..16
         */
        record Qr(String content, int size) implements WireDirective {
        }

        /**
         * A linear barcode.
         *
         * @param system  the symbology to encode with
         * @param content the data to encode
         */
        record Barcode(BarcodeSystem system, String content) implements WireDirective {
        }

        /**
         * A PDF417 stacked barcode.
         *
         * <p>Alone among the symbols this carries a piece of the server's measured geometry.
         * {@code GS ( k} function 65 reads a column count of zero as "printer decides", so a
         * symbol sent without one is laid out by the firmware while the server has already charged
         * a line budget against its own layout — the same symbol printing a different number of
         * rows from the one that was counted. The count crosses the link so the two agree.
         *
         * @param content    the data to encode
         * @param errorLevel error correction level, 0..8
         * @param columns    data columns in the symbol, 1..30, as the server laid it out
         */
        record Pdf417(String content, int errorLevel, int columns) implements WireDirective {
        }

        /**
         * A cash drawer kick.
         *
         * <p>Electrical rather than printed: it fires the solenoid in the drawer and never
         * touches the paper.
         *
         * @param pin the drawer connector pin to pulse, 2 or 5
         */
        record Drawer(int pin) implements WireDirective {
        }

        /**
         * An image whose dots this agent already holds.
         *
         * <p>One of the two shapes the {@code IMAGE} wire directive takes, and the one the
         * design prefers. A stored image was dithered on the server for each of this agent's
         * paper widths and arrived with {@link ConfigSync}, so a job need only say which one —
         * the dots cross the link once per change instead of once per receipt.
         *
         * <p>The width is in dots rather than the percentage the markup was written with. The
         * server did that arithmetic when it chose which raster to sync, so repeating it here
         * would be a second opinion that could round differently and miss.
         *
         * @param name      the image's name, matching one the configuration carried
         * @param widthDots the printed width, which with the name identifies the raster
         */
        record StoredImage(String name, int widthDots) implements WireDirective {
        }

        /**
         * An image carrying its own dots.
         *
         * <p>The other shape, and the more expensive one. A {@code <image>} naming a URL cannot
         * be pre-synced — nothing knows the address until someone writes it into a receipt — and
         * neither can a stored image printed at a width nobody dithered for, since shrinking a
         * raster here would resample dots already reduced to black and white. Both therefore
         * arrive in the job, base64 on the wire, on every print.
         *
         * <p>{@code packed} follows {@link AssetRaster}: one bit per dot, most significant bit
         * first, rows padded to a whole byte, a set bit meaning ink.
         *
         * @param widthDots  the raster's width in printer dots
         * @param heightDots the raster's height in printer dots
         * @param packed     the dots
         */
        record InlineImage(int widthDots, int heightDots, byte[] packed) implements WireDirective {

            public InlineImage {
                packed = packed.clone();
            }
        }
    }
}
