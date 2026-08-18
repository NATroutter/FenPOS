package fi.natroutter.fenpos.device;

import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.link.Frames;

import java.time.Duration;
import java.util.Objects;

/**
 * One printer as the agent knows it, built from the device set the server pushed.
 * <p>
 * Settings are grouped rather than flattened so each consumer depends only on the part it
 * uses — the serial layer takes {@link #serial()}, the compile pipeline takes {@link #print()}
 * and {@link #limits()} — which keeps those layers from reaching into settings that are none
 * of their business.
 * <p>
 * Distinct from {@link Frames.DeviceConfig}, which is the wire shape and must not acquire
 * fields that exist only for the agent's convenience. This is where the wire's flat integers
 * become the durations and policies the rest of the agent works in.
 *
 * @param name    device name, unique within this agent
 * @param serial  serial port settings
 * @param print   printing and encoding settings
 * @param limits  bounds on work accepted for this device
 * @param paused  whether the operator has paused this device from the panel
 */
public record Device(
        String name,
        SerialSettings serial,
        PrintSettings print,
        LimitSettings limits,
        boolean paused) {

    /**
     * How the agent treats a character its codepage cannot represent in a job it composed
     * itself. Rejecting is right for a console {@code test} page — silently substituting would
     * make the page claim the printer supports characters it does not.
     */
    private static final UnsupportedPolicy LOCAL_UNSUPPORTED_POLICY = UnsupportedPolicy.REJECT;

    /** Whether jobs the agent composes itself are wrapped to the device's column count. */
    private static final boolean LOCAL_WRAP = true;

    /** Line terminator for jobs the agent composes itself. */
    private static final Linefeed LOCAL_LINEFEED = Linefeed.LF;

    /**
     * Builds a device from the server's snapshot.
     * <p>
     * The wire carries only what the server has a reason to know. Everything else — how the
     * agent handles an unrepresentable character, whether it wraps, what it terminates lines
     * with — applies solely to jobs the agent composes for itself from the console, since a
     * dispatched job arrives already parsed, wrapped and validated.
     *
     * @param wire the device as the server described it
     * @return the agent's view of that device
     */
    public static Device from(Frames.DeviceConfig wire) {
        Objects.requireNonNull(wire, "wire");
        return new Device(
                wire.name(),
                new SerialSettings(
                        wire.port(),
                        wire.baudRate(),
                        wire.dataBits(),
                        wire.stopBits(),
                        wire.parity(),
                        wire.flowControl(),
                        wire.autoConnect(),
                        wire.autoReconnect(),
                        Duration.ofSeconds(wire.reconnectDelaySeconds()),
                        Duration.ofMillis(wire.writeTimeoutMs())),
                new PrintSettings(
                        wire.columns(),
                        wire.codepage(),
                        LOCAL_UNSUPPORTED_POLICY,
                        LOCAL_WRAP,
                        LOCAL_LINEFEED),
                LimitSettings.DEFAULTS.withMaxQueueDepth(wire.maxQueueDepth()),
                wire.paused());
    }
}
