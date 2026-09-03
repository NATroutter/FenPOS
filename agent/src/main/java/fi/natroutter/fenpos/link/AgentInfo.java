package fi.natroutter.fenpos.link;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * How this agent describes itself to the server.
 * <p>
 * Sent twice — once when pairing, once in every {@code hello} — and treated by the server as
 * untrusted display text. It exists so an operator looking at the Agents page can tell which
 * physical machine a agent is, which is the difference between recognising an unexpected
 * pairing and shrugging at it.
 *
 * @param agentVersion this agent's software version
 * @param platform     operating system and architecture
 * @param hostname     the host this agent runs on
 */
public record AgentInfo(String agentVersion, String platform, String hostname) {

    /** What is reported when the host name cannot be determined. */
    private static final String UNKNOWN_HOST = "unknown";

    /** Product name this agent identifies itself with on the wire. */
    private static final String USER_AGENT_PRODUCT = "FENPos-Agent";

    /**
     * The {@code User-Agent} this agent sends on every request, pairing and link alike.
     * <p>
     * The JDK's default names the HTTP client and the Java version, which tells a proxy log
     * nothing about what was calling and makes an agent indistinguishable from any other Java
     * program. Naming the product and its version means the line in a reverse proxy's access
     * log says what it was, and which release, without anyone opening the agent's own logs.
     *
     * @return the header value, in the {@code product/version} form
     */
    public String userAgent() {
        return USER_AGENT_PRODUCT + "/" + agentVersion;
    }

    /**
     * Describes the machine this process is running on.
     *
     * @param agentVersion this agent's software version
     * @return the description
     */
    public static AgentInfo of(String agentVersion) {
        return new AgentInfo(
                agentVersion,
                System.getProperty("os.name") + " " + System.getProperty("os.arch"),
                resolveHostname());
    }

    /**
     * Resolves the host name.
     * <p>
     * A machine with no resolvable name is ordinary — a container without DNS, a host with a
     * broken {@code /etc/hosts} — and must not stop an agent pairing, so the lookup failing
     * yields a placeholder rather than an exception.
     */
    private static String resolveHostname() {
        String fromEnv = System.getenv("HOSTNAME");
        if (fromEnv != null && !fromEnv.isBlank()) {
            return fromEnv;
        }
        try {
            String name = InetAddress.getLocalHost().getHostName();
            return name == null || name.isBlank() ? UNKNOWN_HOST : name;
        } catch (UnknownHostException e) {
            return UNKNOWN_HOST;
        }
    }
}
