package fi.natroutter.fenpos.http.endpoints;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.http.ApiError;
import fi.natroutter.fenpos.http.AuthException;
import fi.natroutter.fenpos.http.DeviceAuthenticator;
import fi.natroutter.fenpos.http.Route;
import fi.natroutter.fenpos.print.PrintQueue;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import io.javalin.http.Context;

import java.util.Objects;

/**
 * {@code GET /status/<device>} — the state of one printer.
 * <p>
 * Requires the device's own key, so a client can see the printer it prints to and nothing
 * else. Job counts come from the retained records, so they reflect the retention window
 * rather than all time.
 */
public class DeviceStatus extends Route {

    private final PrintService printing;
    private final DeviceConnectionManager connections;
    private final DeviceAuthenticator authenticator;

    /**
     * @param printing      the print service
     * @param connections   the serial layer, for connection state
     * @param authenticator resolves the bearer key to a device
     */
    public DeviceStatus(PrintService printing,
                        DeviceConnectionManager connections,
                        DeviceAuthenticator authenticator) {
        super("status/{device}");
        this.printing = Objects.requireNonNull(printing, "printing");
        this.connections = Objects.requireNonNull(connections, "connections");
        this.authenticator = Objects.requireNonNull(authenticator, "authenticator");
    }

    @Override
    public void get(Context ctx) {
        DeviceSettings device;
        try {
            device = authenticator.authorize(ctx.header("Authorization"), ctx.pathParam("device"));
        } catch (AuthException e) {
            ctx.status(e.status()).json(ApiError.of(e.apiCode(), e.getMessage()));
            return;
        }

        PrintQueue queue = printing.queue(device.name());
        ctx.json(new DeviceView(
                device.name(),
                connections.status(device.name()).name(),
                device.serial().port(),
                device.print().columns(),
                device.print().codepage().name(),
                queue.isPaused(),
                queue.depth(),
                count(device.name(), JobState.COMPLETED),
                count(device.name(), JobState.FAILED)));
    }

    private long count(String deviceName, JobState state) {
        return printing.jobs().forDevice(deviceName).stream()
                .filter(job -> job.state() == state)
                .count();
    }

    /**
     * @param device          device name
     * @param connection      serial connection state
     * @param port            configured OS port name
     * @param columns         paper width in characters
     * @param codepage        active character table
     * @param paused          whether an operator has stopped printing
     * @param queueDepth      jobs waiting
     * @param jobsCompleted   completed jobs still within the retention window
     * @param jobsFailed      failed jobs still within the retention window
     */
    private record DeviceView(
            String device,
            String connection,
            String port,
            int columns,
            String codepage,
            boolean paused,
            int queueDepth,
            long jobsCompleted,
            long jobsFailed) {
    }
}
