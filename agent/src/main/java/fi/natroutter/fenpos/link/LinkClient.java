package fi.natroutter.fenpos.link;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.Diagnostics;
import fi.natroutter.fenpos.store.AgentIdentity;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * The agent's outbound connection to the server.
 * <p>
 * The agent dials; the server never dials in. That is what makes the whole design work behind
 * shop NAT, and it has a security consequence worth stating: the agent opens no listening socket
 * at all, so there is no port to scan and no endpoint to POST to. An attacker on the shop LAN
 * has no network path into it.
 * <p>
 * The connection is expected to drop. A shop's internet goes out, a server restarts, a router
 * reboots overnight — none of those are faults to report and stop on, so this reconnects
 * indefinitely with {@link Backoff} and says so at a volume that does not fill the log.
 * <p>
 * <strong>Threading.</strong> Frames arrive on the HTTP client's threads and are handed
 * straight to the handler. {@link #send} may be called from anywhere — a queue worker reporting
 * a job, the console — and is safe against a socket that closed underneath it.
 */
public class LinkClient {

    /** Path the server accepts agent connections on. Mirrors {@code lib/link/link-path.ts}. */
    private static final String LINK_PATH = "/api/agent-link";

    /** How long to wait for the upgrade to complete. */
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(20);

    /** How long a close handshake is given before the socket is abandoned. */
    private static final Duration CLOSE_TIMEOUT = Duration.ofSeconds(5);

    /**
     * The close code the server sends when an operator unpairs this agent.
     * <p>
     * Mirrors {@code CLOSE.unpaired} in {@code lib/link/agent-connection.ts}. It is the one close
     * that must not be followed by a reconnect: the credential is gone on the server, so every
     * attempt would be refused, and the stored identity would keep the next boot from reading a
     * fresh {@code FENPOS_PAIR_CODE}.
     */
    static final int CLOSE_UNPAIRED = 4003;

    /**
     * Attempts after which failures stop being reported every time.
     * <p>
     * A agent whose server is down for a day would otherwise write tens of thousands of identical
     * error lines and bury whatever else went wrong that day.
     */
    private static final int QUIET_AFTER_ATTEMPTS = 5;

    /**
     * How often a failure is still reported once quiet.
     * <p>
     * Not silence. At the sixty-second ceiling this is roughly half-hourly, which is enough for
     * someone reading the log a day later to see that the agent was trying the whole time rather
     * than having given up.
     */
    private static final int QUIET_REMINDER_EVERY = 30;

    private final FoxLogger logger;
    private final FrameCodec codec = new FrameCodec();
    private final AgentInfo info;
    private final Consumer<Frames.ServerFrame> handler;
    private final HttpClient http;
    private final ScheduledExecutorService scheduler;
    private final Backoff backoff = new Backoff();

    private final AtomicReference<WebSocket> socket = new AtomicReference<>();
    private volatile LinkState state = LinkState.IDLE;
    private volatile AgentIdentity identity;
    private volatile boolean stopped;
    private volatile Runnable unpairedHandler;

    /**
     * @param info    how this agent describes itself in {@code hello}
     * @param handler receives every valid frame the server sends
     * @param logger  where connection lifecycle is reported
     */
    public LinkClient(AgentInfo info, Consumer<Frames.ServerFrame> handler, FoxLogger logger) {
        this.info = Objects.requireNonNull(info, "info");
        this.handler = Objects.requireNonNull(handler, "handler");
        this.logger = Objects.requireNonNull(logger, "logger");
        this.http = HttpClient.newBuilder()
                .connectTimeout(CONNECT_TIMEOUT)
                .build();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "fenpos-agent-link");
            thread.setDaemon(true);
            return thread;
        });
    }

    /**
     * Starts connecting, and keeps reconnecting until {@link #stop()}.
     *
     * @param identity the credential to connect with
     */
    public void start(AgentIdentity identity) {
        this.identity = Objects.requireNonNull(identity, "identity");
        stopped = false;
        backoff.reset();
        connect();
    }

    /**
     * Stops connecting and closes the socket, if there is one.
     * <p>
     * The client remains usable: {@link #start} after this connects again, which is what lets
     * {@code unpair} followed by {@code pair} work in one session rather than requiring a
     * restart between them.
     *
     * @param reason sent in the close frame, for the server's log
     */
    public void stop(String reason) {
        stopped = true;
        state = LinkState.STOPPED;
        identity = null;
        WebSocket open = socket.getAndSet(null);
        if (open != null) {
            open.sendClose(WebSocket.NORMAL_CLOSURE, reason);
        }
    }

    /**
     * Registers what to do when the server unpairs this agent.
     * <p>
     * The link itself only knows to stop: it has no access to the stored credential or the
     * device set, and forgetting both is the caller's decision to make. Called on the HTTP
     * client's thread, after the link has already stopped reconnecting.
     *
     * @param handler runs once per remote unpair
     */
    public void onUnpaired(Runnable handler) {
        this.unpairedHandler = handler;
    }

    /** Stops for good and releases the retry thread. Called once, during shutdown. */
    public void shutdown() {
        stop("agent shutting down");
        scheduler.shutdownNow();
        try {
            if (!scheduler.awaitTermination(CLOSE_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                logger.warn("The link retry thread did not stop within the close timeout");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Returns what the link is currently doing. */
    public LinkState state() {
        if (identity == null && state != LinkState.STOPPED) {
            return LinkState.UNPAIRED;
        }
        return state;
    }

    /** Returns the server this link connects to, or null when unpaired. */
    public String serverUrl() {
        AgentIdentity current = identity;
        return current == null ? null : current.serverUrl();
    }

    /** Returns how many connection attempts have failed since the last success. */
    public long failedAttempts() {
        return backoff.attempts();
    }

    /**
     * Sends a frame, if the link is up.
     * <p>
     * Returns whether it went rather than throwing, because the caller is usually a queue worker
     * reporting a job it has already printed. There is nothing useful for it to do about a
     * closed socket — the server reconciles on reconnect — and an exception there would fail a
     * job that actually succeeded.
     *
     * @param frame the frame to send
     * @return whether it was handed to the socket
     */
    public boolean send(Frames.AgentFrame frame) {
        WebSocket open = socket.get();
        if (open == null || open.isOutputClosed()) {
            return false;
        }
        try {
            open.sendText(codec.write(frame), true);
            Diagnostics.debug(logger, "Sent " + frame.type());
            return true;
        } catch (RuntimeException e) {
            logger.warn("Could not send " + frame.type() + ": " + Diagnostics.describe(e));
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Connection lifecycle
    // -------------------------------------------------------------------------

    /** Opens one connection attempt, scheduling a retry if it fails. */
    private void connect() {
        AgentIdentity current = identity;
        if (stopped || current == null) {
            return;
        }

        URI endpoint;
        try {
            endpoint = endpointFor(current.serverUrl());
        } catch (URISyntaxException e) {
            // The stored URL came from a successful pairing, so this means the store was edited
            // by hand. Retrying cannot fix it, so this is the one failure that gives up.
            logger.error("The stored server address '" + current.serverUrl()
                    + "' is not usable; run 'unpair' and pair again");
            state = LinkState.IDLE;
            return;
        }

        state = LinkState.CONNECTING;
        Diagnostics.debug(logger, "Connecting to " + endpoint + " (attempt " + (backoff.attempts() + 1)
                + " since the last success)");
        http.newWebSocketBuilder()
                .header("Authorization", "Bearer " + current.token())
                .header("User-Agent", info.userAgent())
                .connectTimeout(CONNECT_TIMEOUT)
                .buildAsync(endpoint, new Handler())
                .whenComplete((ws, error) -> {
                    if (error != null) {
                        onConnectFailure(endpoint, error);
                        return;
                    }
                    socket.set(ws);
                    backoff.reset();
                    logger.info("Link established to " + endpoint);
                    send(new Frames.Hello(
                            Frames.PROTOCOL_VERSION,
                            info.agentVersion(),
                            info.platform(),
                            info.hostname()));
                });
    }

    /** Reports a failed attempt at a volume that suits how long it has been failing. */
    private void onConnectFailure(URI endpoint, Throwable error) {
        String detail = describeFailure(error);

        long attempts = backoff.attempts();
        if (attempts < QUIET_AFTER_ATTEMPTS) {
            logger.warn("Could not connect to " + endpoint + ": " + detail);
        } else if (attempts == QUIET_AFTER_ATTEMPTS) {
            logger.warn("Still cannot connect to " + endpoint + ": " + detail
                    + ". Retrying quietly until one succeeds.");
        } else if (attempts % QUIET_REMINDER_EVERY == 0) {
            logger.warn("Still not connected to " + endpoint + " after " + attempts
                    + " attempts: " + detail);
        }

        scheduleReconnect();
    }

    /**
     * Turns a failed connection attempt into one line someone can act on.
     * <p>
     * A refused handshake arrives as a {@link WebSocketHandshakeException} whose message is null:
     * the status the server (or a proxy in front of it) actually answered with is on the response
     * it carries, and the reason is one cause further down. Printing the exception's own text gave
     * a log full of the class name and nothing else, which is what made a proxy returning 502 look
     * identical to a server refusing the token.
     *
     * @param error the failure, as delivered by the HTTP client
     * @return a description naming the HTTP status when there was one, with the stack trace
     *         appended when verbose logging is on
     */
    private static String describeFailure(Throwable error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();

        if (cause instanceof WebSocketHandshakeException handshake) {
            HttpResponse<?> response = handshake.getResponse();
            String status = response == null ? "no response" : "HTTP " + response.statusCode();
            Throwable reason = handshake.getCause();
            String why = reason == null || reason.getMessage() == null ? "" : " (" + reason.getMessage() + ")";
            return "handshake refused with " + status + why + Diagnostics.stackTrace(cause);
        }

        return Diagnostics.describe(cause);
    }

    /** Called when an established connection ends, for any reason. */
    private void onDisconnected(String reason) {
        WebSocket previous = socket.getAndSet(null);
        if (previous == null && state != LinkState.CONNECTING) {
            // Already handled; a close and an error for the same socket both land here.
            return;
        }
        if (!stopped) {
            logger.warn("Link lost: " + reason);
        }
        scheduleReconnect();
    }

    /** Waits out the backoff, then tries again. */
    private void scheduleReconnect() {
        if (stopped) {
            return;
        }
        state = LinkState.CONNECTING;
        Duration delay = backoff.next();
        try {
            scheduler.schedule(this::connect, delay.toMillis(), TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // The scheduler was shut down between the check and the schedule, which only
            // happens during shutdown. Nothing to retry into.
            state = LinkState.STOPPED;
        }
    }

    /**
     * Builds the WebSocket endpoint from the stored server address.
     * <p>
     * The scheme is mapped rather than assumed, so an install paired over plain HTTP against
     * loopback connects over {@code ws} and one paired over HTTPS connects over {@code wss}. A
     * fixed scheme would silently fail one of the two.
     */
    private static URI endpointFor(String serverUrl) throws URISyntaxException {
        String trimmed = serverUrl.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }

        URI base = new URI(trimmed);
        String scheme = base.getScheme() == null ? "" : base.getScheme().toLowerCase(Locale.ROOT);
        String socketScheme = switch (scheme) {
            case "https", "wss" -> "wss";
            case "http", "ws" -> "ws";
            default -> throw new URISyntaxException(serverUrl, "unsupported scheme '" + scheme + "'");
        };

        return new URI(socketScheme + "://" + base.getRawAuthority()
                + (base.getRawPath() == null ? "" : base.getRawPath()) + LINK_PATH);
    }

    /**
     * Reads frames off one socket.
     * <p>
     * A new instance per connection, so a message half-received when a socket dies cannot leak
     * into the next one.
     */
    private final class Handler implements WebSocket.Listener {

        /**
         * Accumulates a message delivered in parts.
         * <p>
         * The transport may split a frame across several calls, so a partial message is buffered
         * until the final part arrives. Bounded, because a server streaming an unbounded message
         * would otherwise exhaust this process's memory before any validation could run — the
         * one thing a compromised server could do here that costs nothing to defend.
         */
        private final StringBuilder partial = new StringBuilder();

        @Override
        public void onOpen(WebSocket webSocket) {
            state = LinkState.CONNECTED;
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            if (partial.length() + data.length() > FrameCodec.MAX_FRAME_BYTES) {
                partial.setLength(0);
                logger.error("Server sent a frame larger than "
                        + FrameCodec.MAX_FRAME_BYTES + " bytes; closing the link");
                webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "frame too large");
                return null;
            }

            partial.append(data);
            if (last) {
                String raw = partial.toString();
                partial.setLength(0);
                deliver(raw);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            if (statusCode == CLOSE_UNPAIRED) {
                onUnpairedByServer();
                return null;
            }
            onDisconnected("closed by the server (" + statusCode
                    + (reason == null || reason.isBlank() ? "" : ": " + reason) + ")");
            return null;
        }

        /**
         * Stops for good rather than reconnecting: the credential this link was using no longer
         * exists on the server. What happens to the stored copy is the registered handler's
         * business.
         */
        private void onUnpairedByServer() {
            socket.set(null);
            stopped = true;
            identity = null;
            state = LinkState.STOPPED;
            logger.warn("The server unpaired this agent. The link will not reconnect until it is "
                    + "paired again.");
            Runnable handler = unpairedHandler;
            if (handler != null) {
                handler.run();
            }
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            onDisconnected(Diagnostics.describe(error));
        }

        /**
         * Parses one frame and hands it on.
         * <p>
         * A frame this agent cannot parse is logged and dropped, never fatal. A newer server may
         * send frames this version has no need to understand, and closing the link over one
         * would take a working printer offline for a message that did not concern it.
         */
        private void deliver(String raw) {
            Frames.ServerFrame frame;
            try {
                frame = codec.read(raw);
            } catch (ProtocolException e) {
                logger.warn("Ignored a frame from the server: " + Diagnostics.describe(e));
                return;
            }

            Diagnostics.debug(logger, "Received " + frame.type() + " (" + raw.length() + " chars)");
            try {
                handler.accept(frame);
            } catch (RuntimeException e) {
                // A handler failure is a bug in this agent, not a reason to drop the link and
                // stop every other frame behind it.
                logger.error("Failed to handle a " + frame.type() + " frame: " + Diagnostics.describe(e));
            }
        }
    }
}
