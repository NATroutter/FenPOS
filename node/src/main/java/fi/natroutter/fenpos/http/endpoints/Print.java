package fi.natroutter.fenpos.http.endpoints;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.http.ApiError;
import fi.natroutter.fenpos.http.AuthException;
import fi.natroutter.fenpos.http.DeviceAuthenticator;
import fi.natroutter.fenpos.http.Route;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintRequestException;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.print.QueueRejectedException;
import io.javalin.http.Context;
import io.javalin.http.HttpStatus;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * {@code POST /print/<device>} — validates a request, renders it, and queues it.
 * <p>
 * Everything except the actual write happens before the response is sent, so a {@code 202}
 * means the payload is complete and correct and only the hardware can still fail it.
 */
public class Print extends Route {

    private final PrintService printing;
    private final DeviceAuthenticator authenticator;

    /**
     * @param printing      the print service
     * @param authenticator resolves the bearer key to a device
     */
    public Print(PrintService printing, DeviceAuthenticator authenticator) {
        super("print/{device}");
        this.printing = Objects.requireNonNull(printing, "printing");
        this.authenticator = Objects.requireNonNull(authenticator, "authenticator");
    }

    @Override
    public void post(Context ctx) {
        DeviceSettings device;
        try {
            device = authenticator.authorize(ctx.header("Authorization"), ctx.pathParam("device"));
        } catch (AuthException e) {
            ctx.status(e.status()).json(ApiError.of(e.apiCode(), e.getMessage()));
            return;
        }

        if (!isJson(ctx.contentType())) {
            ctx.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).json(ApiError.of(
                    "invalid_content_type", "Content-Type must be application/json"));
            return;
        }

        String body = ctx.body();
        int limit = device.limits().maxBodyBytes();
        if (body.getBytes(StandardCharsets.UTF_8).length > limit) {
            ctx.status(HttpStatus.CONTENT_TOO_LARGE).json(ApiError.of(
                    "body_too_large", "Request body may be at most " + limit + " bytes"));
            return;
        }

        try {
            PrintJob job = printing.submit(device, body);
            ctx.status(HttpStatus.ACCEPTED).json(new Accepted(job.id(), job.state().name()));
        } catch (PrintRequestException e) {
            ctx.status(e.status()).json(ApiError.from(e));
        } catch (QueueRejectedException e) {
            ctx.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .json(ApiError.of(e.apiCode(), e.getMessage()));
        }
    }

    /**
     * Accepts a content type with or without parameters, so
     * {@code application/json; charset=utf-8} is treated as JSON.
     */
    private static boolean isJson(String contentType) {
        if (contentType == null) {
            return false;
        }
        String base = contentType.split(";", 2)[0].strip();
        return base.equalsIgnoreCase("application/json");
    }

    /**
     * The {@code 202} body.
     *
     * @param id     the job identifier to poll
     * @param status the job's state at the moment it was accepted
     */
    private record Accepted(String id, String status) {
    }
}
