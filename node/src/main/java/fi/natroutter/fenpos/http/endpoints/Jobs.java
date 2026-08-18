package fi.natroutter.fenpos.http.endpoints;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.http.ApiError;
import fi.natroutter.fenpos.http.AuthException;
import fi.natroutter.fenpos.http.DeviceAuthenticator;
import fi.natroutter.fenpos.http.JobView;
import fi.natroutter.fenpos.http.Route;
import fi.natroutter.fenpos.print.PrintJob;
import fi.natroutter.fenpos.print.PrintService;
import io.javalin.http.Context;
import io.javalin.http.HttpStatus;

import java.util.Objects;
import java.util.Optional;

/**
 * {@code GET /jobs/<id>} and {@code DELETE /jobs/<id>} — inspect and withdraw jobs.
 * <p>
 * A job belonging to another device is reported as {@code 404} rather than {@code 403}, so
 * a caller holding one device's key cannot probe which identifiers exist on another.
 */
public class Jobs extends Route {

    private final PrintService printing;
    private final DeviceAuthenticator authenticator;

    /**
     * @param printing      the print service holding the job store
     * @param authenticator resolves the bearer key to a device
     */
    public Jobs(PrintService printing, DeviceAuthenticator authenticator) {
        super("jobs/{id}");
        this.printing = Objects.requireNonNull(printing, "printing");
        this.authenticator = Objects.requireNonNull(authenticator, "authenticator");
    }

    @Override
    public void get(Context ctx) {
        resolve(ctx).ifPresent(job -> ctx.json(JobView.of(job)));
    }

    @Override
    public void delete(Context ctx) {
        resolve(ctx).ifPresent(job -> {
            if (job.cancel()) {
                ctx.json(JobView.of(job));
            } else {
                ctx.status(HttpStatus.CONFLICT).json(ApiError.of("job_not_cancellable",
                        "Job " + job.id() + " is already " + job.state().name().toLowerCase()));
            }
        });
    }

    /**
     * Authorises the caller and finds the job, writing the error response itself when it
     * cannot.
     *
     * @return the job, or empty when a response has already been written
     */
    private Optional<PrintJob> resolve(Context ctx) {
        String id = ctx.pathParam("id");

        DeviceSettings device;
        try {
            device = authenticator.identify(ctx.header("Authorization"));
        } catch (AuthException e) {
            ctx.status(e.status()).json(ApiError.of(e.apiCode(), e.getMessage()));
            return Optional.empty();
        }

        Optional<PrintJob> job = printing.jobs().find(id)
                .filter(found -> found.deviceName().equals(device.name()));

        if (job.isEmpty()) {
            // An unknown id, an expired one, and one belonging to another device are
            // deliberately indistinguishable: the store cannot tell the first two apart,
            // and separating the third would leak the existence of other devices' jobs.
            ctx.status(HttpStatus.NOT_FOUND).json(ApiError.of("unknown_job",
                    "No job '" + id + "' is accessible with this key"));
        }
        return job;
    }

}
