package fi.natroutter.fenpos.pair;

import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.link.AgentInfo;
import fi.natroutter.fenpos.link.Frames;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.Objects;

/**
 * Redeems a pairing code for this agent's long-lived credential.
 * <p>
 * <strong>Transport security is not negotiable here.</strong> The response to this one request
 * carries the token that authorises every future connection, so in cleartext it is readable by
 * anyone on the path and the whole system is compromised at its first breath. Two rules follow,
 * and neither has an override:
 * <ul>
 *   <li>{@code http://} is rejected before a socket is opened.</li>
 *   <li>Certificates are validated by {@link HttpClient}'s defaults, and this class provides no
 *       flag, property or environment variable to disable that. Embedded agents get this wrong
 *       precisely because someone adds a "trust all certificates" switch for a staging
 *       environment and it survives into production.</li>
 * </ul>
 * An operator with a self-signed certificate adds it to the JVM trust store, which is a
 * deliberate act with a record of itself, rather than passing a flag nobody reviews.
 */
public class PairingClient {

    /** Path the server exposes for redemption. */
    private static final String PAIR_PATH = "/api/pair";

    /** How long to wait for the connection, and then for the response. */
    private static final Duration TIMEOUT = Duration.ofSeconds(20);

    /** Largest response body read. The reply is four short strings. */
    private static final int MAX_RESPONSE_BYTES = 8 * 1024;

    private final HttpClient http;

    /** Creates a client with strict, default TLS validation. */
    public PairingClient() {
        this(HttpClient.newBuilder()
                .connectTimeout(TIMEOUT)
                // HTTP/1.1 outright, because the default of HTTP/2 does something over plain http
                // that the server cannot survive: the JDK sends the first request with an
                // "Upgrade: h2c" header to ask for HTTP/2, and Node hands any request carrying an
                // Upgrade header to its upgrade listener rather than its request handler. The
                // pairing POST then never reaches the route. Over https the two negotiate through
                // ALPN and the header is never sent, which is why this only bit the loopback
                // install — the one case that pairs over http at all.
                .version(HttpClient.Version.HTTP_1_1)
                // Redirects are not followed. A redirect on this request could move the
                // credential exchange to a host the operator never named.
                .followRedirects(HttpClient.Redirect.NEVER)
                .build());
    }

    /**
     * @param http the HTTP client to use; supplied by tests, which point it at a local server
     */
    PairingClient(HttpClient http) {
        this.http = Objects.requireNonNull(http, "http");
    }

    /**
     * Exchanges a pairing code for a credential.
     *
     * @param serverUrl the server's base URL, as the operator typed it
     * @param code      the pairing code shown in the panel
     * @param info      how this agent describes itself, recorded by the server for display
     * @return the granted credential
     * @throws PairingException when the address is unusable, unreachable, or the code refused
     */
    public PairingGrant redeem(String serverUrl, String code, AgentInfo info)
            throws PairingException {
        URI endpoint = endpointFor(serverUrl);
        String body = requestBody(code, info);

        HttpResponse<String> response;
        try {
            response = http.send(
                    HttpRequest.newBuilder(endpoint)
                            .timeout(TIMEOUT)
                            .header("Content-Type", "application/json")
                            .header("User-Agent", info.userAgent())
                            .POST(HttpRequest.BodyPublishers.ofString(body))
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            throw new PairingException(
                    "Could not reach " + endpoint + ": " + describe(e), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PairingException("Pairing was interrupted", e);
        }

        return readGrant(response);
    }

    /**
     * Builds and checks the redemption endpoint.
     * <p>
     * The scheme check happens here rather than at the call site so every route into pairing —
     * console, environment, or a future one — inherits it.
     */
    private static URI endpointFor(String serverUrl) throws PairingException {
        if (serverUrl == null || serverUrl.isBlank()) {
            throw new PairingException("A server address is required, for example "
                    + "https://fenpos.example.com");
        }

        String trimmed = serverUrl.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }

        URI base;
        try {
            base = new URI(trimmed);
        } catch (URISyntaxException e) {
            throw new PairingException("'" + serverUrl + "' is not a valid address", e);
        }

        String scheme = base.getScheme() == null ? "" : base.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.isEmpty() || base.getHost() == null) {
            throw new PairingException("'" + serverUrl + "' is not a complete address; include "
                    + "the scheme, for example https://fenpos.example.com");
        }
        if (!"https".equals(scheme) && !isLoopback(base.getHost())) {
            throw new PairingException("Pairing requires https. The reply to this request "
                    + "carries this agent's credential, and over " + scheme
                    + " anyone on the network path could read it.");
        }

        try {
            return new URI(trimmed + PAIR_PATH);
        } catch (URISyntaxException e) {
            throw new PairingException("'" + serverUrl + "' is not a valid address", e);
        }
    }

    /**
     * Whether an address names this machine.
     * <p>
     * The single exception to the https rule, and it is a property of the address rather than a
     * setting: traffic to loopback never reaches a network interface, so there is no path for
     * anyone to read the credential off. It exists so the system can be brought up and tested
     * on one machine without standing up a certificate first.
     * <p>
     * Deliberately not a flag. The hazard the https rule defends against is someone adding a
     * "skip TLS" switch for a staging environment and it surviving into production; a rule tied
     * to the address cannot survive being pointed at a real host.
     * <p>
     * Decided on the parsed address rather than on the text, because a prefix is not an address:
     * this used to accept anything beginning "127.", and {@code 127.0.0.1.evil.example} is a name
     * anyone can register. A literal is required before {@link InetAddress} is asked, so no name
     * server is consulted; resolving here would trade a prefix bug for a rebinding one, where the
     * answer depends on what DNS says at the moment of the check rather than on what the operator
     * typed.
     *
     * @param host the host from the address
     * @return whether it is a loopback address
     */
    private static boolean isLoopback(String host) {
        if (host == null) {
            return false;
        }
        String bare = host.startsWith("[") && host.endsWith("]")
                ? host.substring(1, host.length() - 1)
                : host;
        if (bare.equalsIgnoreCase("localhost")) {
            return true;
        }
        if (!isNumericAddress(bare)) {
            return false;
        }
        try {
            return InetAddress.getByName(bare).isLoopbackAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    /**
     * Whether a host is already written as an IP address, so that resolving it asks no name server.
     *
     * <p>A colon can only appear in an IPv6 literal. Otherwise every character has to be a digit or
     * a dot, which admits the shorthands {@code 127.1} and {@code 2130706433} alongside dotted
     * quads: those are genuinely loopback, and letting {@link InetAddress} decide is better than
     * reimplementing its arithmetic here. What matters is that a name never reaches it.
     */
    private static boolean isNumericAddress(String host) {
        if (host.isEmpty()) {
            return false;
        }
        if (host.indexOf(':') >= 0) {
            return true;
        }
        for (int index = 0; index < host.length(); index++) {
            char character = host.charAt(index);
            if (character != '.' && (character < '0' || character > '9')) {
                return false;
            }
        }
        return true;
    }

    /** Builds the redemption request body. */
    private static String requestBody(String code, AgentInfo info) throws PairingException {
        if (code == null || code.isBlank()) {
            throw new PairingException("A pairing code is required; generate one in the panel "
                    + "under Agents");
        }

        JsonObject json = new JsonObject();
        json.addProperty("code", code.trim());
        json.addProperty("protocolVersion", Frames.PROTOCOL_VERSION);
        json.addProperty("agentVersion", info.agentVersion());
        json.addProperty("platform", info.platform());
        json.addProperty("hostname", info.hostname());
        return json.toString();
    }

    /**
     * Turns a response into a grant, or into a message the operator can act on.
     * <p>
     * The server answers every refusal identically on purpose, so that this endpoint cannot be
     * used to tell a wrong code from an expired one. That is reflected back honestly rather
     * than guessed at: the agent says the code was not accepted and lists what would explain
     * it, instead of asserting a reason it was not told.
     */
    private static PairingGrant readGrant(HttpResponse<String> response) throws PairingException {
        String body = response.body() == null ? "" : response.body();
        if (body.length() > MAX_RESPONSE_BYTES) {
            throw new PairingException("The server's reply was implausibly large; check that "
                    + "the address points at a FenPOS server");
        }

        int status = response.statusCode();
        if (status == 401) {
            throw new PairingException("That pairing code was not accepted. It may be mistyped, "
                    + "expired, or already used — generate a new one in the panel under Agents.");
        }
        if (status == 429) {
            throw new PairingException("The server is rate limiting pairing attempts. "
                    + "Wait a minute and try again.");
        }
        if (status != 200) {
            throw new PairingException("The server refused the pairing request with HTTP "
                    + status + serverMessage(body));
        }

        JsonObject json;
        try {
            var parsed = JsonParser.parseString(body);
            if (!parsed.isJsonObject()) {
                throw new PairingException("The server's reply was not a JSON object; check that "
                        + "the address points at a FenPOS server");
            }
            json = parsed.getAsJsonObject();
        } catch (JsonParseException e) {
            throw new PairingException("The server's reply was not valid JSON; check that the "
                    + "address points at a FenPOS server", e);
        }

        String agentId = string(json, "agentId");
        String agentName = string(json, "agentName");
        String token = string(json, "token");
        if (agentId == null || agentName == null || token == null) {
            throw new PairingException("The server's reply was missing the credential");
        }

        Integer version = json.has("protocolVersion") && json.get("protocolVersion").isJsonPrimitive()
                ? json.get("protocolVersion").getAsInt()
                : null;
        if (version != null && version != Frames.PROTOCOL_VERSION) {
            throw new PairingException("This server speaks link protocol " + version
                    + "; this agent speaks " + Frames.PROTOCOL_VERSION + ". Update the agent.");
        }

        return new PairingGrant(agentId, agentName, token);
    }

    /**
     * Extracts the server's own explanation from an error body.
     * <p>
     * A body that is not the server's JSON is usually a proxy answering in its place, and its text
     * is the only thing that says so — an HTML error page names the proxy, a gateway timeout names
     * the upstream it gave up on. Discarding it left pairing failures reading as a bare status code
     * with no hint that the server was never reached at all, so an unparseable body is quoted
     * instead, trimmed to one line's worth.
     */
    private static String serverMessage(String body) {
        try {
            var parsed = JsonParser.parseString(body);
            if (parsed.isJsonObject()) {
                String message = string(parsed.getAsJsonObject(), "message");
                if (message != null) {
                    return ": " + message;
                }
            }
        } catch (JsonParseException e) {
            // Fall through to quoting the body, which is what a proxy's reply needs.
        }
        return body == null || body.isBlank() ? "" : ": " + summarise(body);
    }

    /** Longest error body quoted back into a failure message. */
    private static final int BODY_EXCERPT = 200;

    /** Flattens a body to one line and caps it, so a whole HTML page cannot become the message. */
    private static String summarise(String body) {
        String flattened = body.strip().replaceAll("\\s+", " ");
        return flattened.length() <= BODY_EXCERPT
                ? flattened
                : flattened.substring(0, BODY_EXCERPT) + "…";
    }

    private static String string(JsonObject json, String field) {
        var element = json.get(field);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            return null;
        }
        String value = element.getAsString();
        return value.isBlank() ? null : value;
    }

    /**
     * Describes a transport failure in terms of what the operator should check.
     * <p>
     * The exception class carries the diagnosis — a certificate problem is a different action
     * from a name that does not resolve — and the default message often does not say which.
     */
    private static String describe(IOException e) {
        String type = e.getClass().getSimpleName();
        String detail = e.getMessage() == null ? type : e.getMessage();
        if (e instanceof javax.net.ssl.SSLException) {
            return detail + " (the server's certificate was not trusted; if it is self-signed, "
                    + "add it to this machine's Java trust store)";
        }
        if (e instanceof java.net.UnknownHostException) {
            return "the host name could not be resolved";
        }
        if (e instanceof java.net.ConnectException) {
            return "the connection was refused; check the address and that the server is running";
        }
        if (e instanceof java.net.http.HttpTimeoutException) {
            return "the server did not answer in time";
        }
        return detail;
    }
}
