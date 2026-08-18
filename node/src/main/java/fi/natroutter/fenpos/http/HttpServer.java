package fi.natroutter.fenpos.http;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.FenPOS;
import fi.natroutter.fenpos.config.data.HttpSettings;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.http.ApiError;
import fi.natroutter.fenpos.http.GsonJsonMapper;
import fi.natroutter.fenpos.http.Route;
import io.javalin.Javalin;
import io.javalin.config.RoutesConfig;
import io.javalin.http.HttpStatus;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Hosts the HTTP API.
 * <p>
 * Routes register every method they might answer, so a request using an unsupported method
 * gets {@code 405} from {@link Route}'s defaults rather than a confusing {@code 404}.
 */
public class HttpServer {

    private final HttpSettings settings;
    private final FoxLogger logger;
    private final long maxRequestSize;
    private final List<Route> routes = new ArrayList<>();

    private Javalin server;

    /**
     * @param config         application configuration
     * @param logger         logger for startup messages
     */
    public HttpServer(ResolvedConfig config, FoxLogger logger) {
        this.settings = Objects.requireNonNull(config.http(), "settings");
        this.logger = Objects.requireNonNull(logger, "logger");
        this.maxRequestSize = largestBodyLimit(config);
    }

    /**
     * Returns the largest per-device body limit.
     * <p>
     * Javalin enforces one ceiling for the whole listener, so it has to admit the most
     * permissive device; each request is then checked again against its own device's limit.
     */
    private static long largestBodyLimit(ResolvedConfig config) {
        return config.devices().values().stream()
                .mapToLong(device -> device.limits().maxBodyBytes())
                .max()
                .orElse(65536);
    }

    /** Registers routes to be served. Must be called before {@link #start()}. */
    public void register(Route... toAdd) {
        routes.addAll(List.of(toAdd));
    }

    /**
     * Binds the listener and begins serving.
     *
     * @throws IllegalStateException if no valid routes were registered, since a printer
     *                               daemon serving nothing is a misconfiguration rather
     *                               than a running system
     */
    public void start() {
        if (!settings.enabled()) {
            logger.info("HTTP server disabled by configuration");
            return;
        }
        if (routes.isEmpty()) {
            throw new IllegalStateException("No API routes registered");
        }
        if (server != null) {
            return;
        }

        server = Javalin.create(config -> {
            config.startup.showJavalinBanner = false;
            config.jsonMapper(new GsonJsonMapper());
            // A hard ceiling on buffered request bodies, independent of any per-device
            // limit: it bounds memory before ThermAPI's own validation ever runs.
            config.http.maxRequestSize = maxRequestSize;
            configureRoutes(config.routes);
            configureErrorHandling(config.routes);
        });

        server.start(settings.host(), settings.port());
        logger.info("HTTP server listening on " + settings.host() + ":" + server.port());
    }

    private void configureRoutes(RoutesConfig config) {
        config.get("/", ctx -> ctx.result("ThermAPI v" + FenPOS.getVERSION()));

        for (Route route : routes) {
            String path = normalise(route.getPath());
            if (path == null) {
                logger.warn("Skipping endpoint with no path: " + route.getClass().getSimpleName());
                continue;
            }

            config.get(path, route::get);
            config.post(path, route::post);
            config.put(path, route::put);
            config.patch(path, route::patch);
            config.delete(path, route::delete);
            config.head(path, route::head);
            config.options(path, route::options);

            logger.info("Registered route: " + join(settings.publicAddress(), path));
        }
    }

    /**
     * Turns anything that escapes a handler into the standard error shape.
     * <p>
     * The detail is logged but not returned: an exception message can carry internal paths
     * or configuration values, and the caller can do nothing with them anyway.
     */
    private void configureErrorHandling(RoutesConfig config) {
        config.exception(Exception.class, (e, ctx) -> {
            logger.error("Unhandled error serving " + ctx.method() + " " + ctx.path(), e);
            ctx.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .json(ApiError.of("internal_error", "The request could not be completed"));
        });
    }

    /** Returns the path with exactly one leading slash, or {@code null} if unusable. */
    private static String normalise(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }
        String trimmed = path.strip();
        while (trimmed.startsWith("/")) {
            trimmed = trimmed.substring(1);
        }
        return "/" + trimmed;
    }

    /** Joins a base URL and a path for display, tolerating missing or extra slashes. */
    private static String join(String baseUrl, String path) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return path;
        }
        String base = baseUrl.strip();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + path;
    }

    /** Stops the listener, if it is running. */
    public void stop() {
        if (server != null) {
            server.stop();
            server = null;
            logger.info("HTTP server stopped");
        }
    }
}
